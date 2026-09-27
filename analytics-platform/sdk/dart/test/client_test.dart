import 'dart:convert';
import 'dart:typed_data';

import 'package:analytics_platform/analytics_platform.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

typedef Handler = Future<http.Response> Function(http.Request request, int index);

http.Response jsonResponse(Object? body, [int status = 200, Map<String, String> headers = const {}]) =>
    http.Response(body == null ? '' : jsonEncode(body), status, headers: {'content-type': 'application/json', ...headers});

String tokens(int n) => jsonEncode({'access_token': 'access-$n', 'refresh_token': 'refresh-$n', 'expires_in': 900, 'token_type': 'bearer'});

void main() {
  late List<http.Request> requests;
  late List<Duration> sleeps;

  AnalyticsPlatformClient client(Handler handler, {String? apiKey, TokenStore? store, int maxRetries = 3}) {
    requests = [];
    sleeps = [];
    final mock = MockClient((request) {
      requests.add(request);
      return handler(request, requests.length - 1);
    });
    return AnalyticsPlatformClient(ClientConfig(
      baseUrl: Uri.parse('https://api.test'),
      apiKey: apiKey,
      tokenStore: store,
      maxRetries: maxRetries,
      httpClient: mock,
      sleep: (d) async => sleeps.add(d),
    ));
  }

  Handler queue(List<http.Response Function()> replies) {
    var i = 0;
    return (request, _) async {
      if (i >= replies.length) throw StateError('unexpected request ${request.method} ${request.url}');
      return replies[i++]();
    };
  }

  Object? bodyOf(http.Request r) => r.body.isEmpty ? null : jsonDecode(r.body);

  test('API key header and typed errors', () async {
    final ap = client(
      queue([
        () => jsonResponse([
              {
                'id': 'e1',
                'name': 'churn',
                'status': 'active',
                'routes': [
                  {'model_version_id': 'mv1', 'weight': 100}
                ]
              }
            ]),
        () => jsonResponse({
              'detail': {'code': 'bad_features', 'message': 'missing feature: plan'}
            }, 422),
        () => jsonResponse({'detail': 'endpoint nope not found'}, 404),
      ]),
      apiKey: 'ap_live_123',
    );
    final endpoints = await ap.endpoints.list();
    expect(endpoints.single.routes.single.modelVersionId, 'mv1');
    expect(requests[0].headers['X-API-Key'], 'ap_live_123');
    expect(requests[0].headers.containsKey('Authorization'), isFalse);
    expect(requests[0].url.toString(), 'https://api.test/v1/endpoints');

    await expectLater(
      ap.endpoints.predict('churn', [
        {'age': 3}
      ]),
      throwsA(isA<ValidationException>()
          .having((e) => e.code, 'code', 'bad_features')
          .having((e) => e.message, 'message', contains('missing feature: plan'))),
    );
    await expectLater(ap.endpoints.get('nope'), throwsA(isA<NotFoundException>().having((e) => e.status, 'status', 404)));
  });

  test('login persists tokens and concurrent 401s share one refresh', () async {
    var current = 'access-1';
    var refreshes = 0;
    final store = InMemoryTokenStore();
    final ap = client((request, _) async {
      switch (request.url.path) {
        case '/v1/auth/login':
          return http.Response(tokens(1), 200);
        case '/v1/auth/refresh':
          expect(bodyOf(request), {'refresh_token': 'refresh-1'});
          refreshes++;
          current = 'access-${refreshes + 1}';
          return http.Response(tokens(refreshes + 1), 200);
        default:
          if (request.headers['Authorization'] == 'Bearer $current' && current != 'access-1') {
            return jsonResponse({'tenant_id': 'acme', 'id': 'u1', 'role': 'admin', 'method': 'jwt'});
          }
          return jsonResponse({
            'detail': {'code': 'token_expired'}
          }, 401);
      }
    }, store: store);

    final pair = await ap.auth.login('ada@acme.example', 'Correct-Horse-9', totp: '123456');
    expect(pair.refreshToken, 'refresh-1');
    expect(bodyOf(requests[0]), {'email': 'ada@acme.example', 'password': 'Correct-Horse-9', 'totp': '123456'});
    expect(requests[0].headers.containsKey('Authorization'), isFalse);

    final results = await Future.wait([ap.auth.me(), ap.auth.me(), ap.auth.me()]);
    expect(results.map((m) => m.id), ['u1', 'u1', 'u1']);
    expect(refreshes, 1);
    expect(await store.load(), const Tokens(accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900, tokenType: 'bearer'));
  });

  test('a rejected refresh token clears the session', () async {
    final store = InMemoryTokenStore(const Tokens(accessToken: 'stale', refreshToken: 'used'));
    final ap = client(
        queue([
          () => jsonResponse({'detail': 'expired'}, 401),
          () => jsonResponse({
                'detail': {'code': 'token_reuse'}
              }, 401),
        ]),
        store: store);
    await expectLater(ap.auth.me(), throwsA(isA<AuthenticationException>().having((e) => e.code, 'code', 'token_reuse')));
    expect(await store.load(), isNull);
    expect(await ap.auth.isLoggedIn(), isFalse);
  });

  test('predict is idempotent: retried on 5xx and honoring Retry-After', () async {
    final ap = client(
        queue([
          () => jsonResponse({'detail': 'bad gateway'}, 502),
          () => jsonResponse({'detail': 'slow down'}, 429, {'retry-after': '2'}),
          () => jsonResponse({
                'predictions': ['yes'],
                'probabilities': [
                  [0.2, 0.8]
                ],
                'classes': ['no', 'yes'],
                'model_version': {'model_id': 'm1', 'version': 3}
              }),
        ]),
        apiKey: 'k');
    final out = await ap.endpoints.predict('churn', [
      {'tenure': 3, 'plan': 'pro', 'vip': null}
    ]);
    expect(out.labels, ['yes']);
    expect(out.probabilities, [
      [0.2, 0.8]
    ]);
    expect(out.modelVersion!.version, 3);
    expect(requests, hasLength(3));
    expect(sleeps[1], const Duration(seconds: 2));
    expect(bodyOf(requests[0]), {
      'instances': [
        {'tenure': 3, 'plan': 'pro', 'vip': null}
      ],
      'explain': false
    });
  });

  test('batch uploads are not retried on 5xx but are on 503', () async {
    final failing = client(
        queue([
          () => jsonResponse({'detail': 'boom'}, 500)
        ]),
        apiKey: 'k');
    await expectLater(failing.endpoints.batch('churn', Uint8List.fromList(utf8.encode('a,b\n1,2\n'))), throwsA(isA<ServerException>()));
    expect(requests, hasLength(1));

    // MockClient turns multipart requests into http.Request copies, so look at the finalized body.
    final busy = client(
        queue([
          () => jsonResponse({'detail': 'busy'}, 503),
          () => jsonResponse({'id': 'j1', 'type': 'serving.batch_predict', 'status': 'queued'}),
        ]),
        apiKey: 'k');
    final job = await busy.endpoints.batch('churn', Uint8List.fromList(utf8.encode('a,b\n1,2\n')), filename: 'customers.csv');
    expect(job.id, 'j1');
    expect(requests, hasLength(2));
    expect(requests[1].headers['content-type'], startsWith('multipart/form-data; boundary='));
    expect(requests[1].body, contains('filename="customers.csv"'));
  });

  test('connection failures are retried, then surface as NetworkException', () async {
    var calls = 0;
    final ap = client((request, _) async {
      calls++;
      if (calls == 1) throw http.ClientException('Connection refused');
      return jsonResponse({'id': 'j1', 'type': 't', 'status': 'running', 'progress': 0.5});
    }, apiKey: 'k');
    expect((await ap.jobs.get('j1')).status, 'running');

    final down = client((request, _) async => throw http.ClientException('Failed host lookup: api.test'), apiKey: 'k', maxRetries: 1);
    await expectLater(down.jobs.get('j1'), throwsA(isA<NetworkException>()));
    expect(requests, hasLength(2));

    // A reset on a non-idempotent request is not retried: the server may have acted on it.
    final reset = client((request, _) async => throw http.ClientException('Connection reset by peer'), apiKey: 'k');
    await expectLater(reset.jobs.cancel('j1'), throwsA(isA<NetworkException>()));
    expect(requests, hasLength(1));
  });

  test('rate limit errors carry retryAfter when retries run out', () async {
    final ap = client(
        queue([
          () => jsonResponse({'detail': 'rate limit exceeded'}, 429, {'retry-after': '7'})
        ]),
        apiKey: 'k',
        maxRetries: 0);
    await expectLater(
        ap.jobs.list(), throwsA(isA<RateLimitException>().having((e) => e.retryAfter, 'retryAfter', const Duration(seconds: 7))));
  });

  test('anomaly and forecast shapes', () async {
    final ap = client(
        queue([
          () => jsonResponse({
                'predictions': [
                  {'is_anomaly': true, 'score': 0.91},
                  {'is_anomaly': false, 'score': 0.12}
                ],
                'threshold': 0.5,
                'model_version': {'model_id': 'm', 'version': 1}
              }),
          () => jsonResponse({
                'horizon': 2,
                'timestamps': ['2026-10-01', '2026-10-02'],
                'predictions': [10.5, 11],
                'lower': [9.0, 9.2],
                'upper': [12.0, 12.8],
                'interval_level': 0.9,
                'model_version': {'model_id': 'f', 'version': 2}
              }),
        ]),
        apiKey: 'k');
    final anomalies = await ap.endpoints.predict('fraud', [
      {'amount': 9000}
    ]);
    expect(anomalies.anomalies, [const AnomalyPrediction(true, 0.91), const AnomalyPrediction(false, 0.12)]);
    expect(anomalies.threshold, 0.5);
    final forecast = await ap.endpoints.forecast('sales', horizon: 2, history: [
      {'timestamp': '2026-09-30', 'value': 10}
    ]);
    expect(forecast.predictions, [10.5, 11.0]);
    expect(forecast.intervalLevel, 0.9);
    expect(bodyOf(requests[1]), {
      'horizon': 2,
      'history': [
        {'timestamp': '2026-09-30', 'value': 10}
      ],
      'explain': false
    });
  });

  test('jobs.wait polls with growing intervals and throws on failure', () async {
    final ap = client(
        queue([
          () => jsonResponse({'id': 'j', 'type': 't', 'status': 'queued'}),
          () => jsonResponse({'id': 'j', 'type': 't', 'status': 'running', 'progress': 0.5}),
          () => jsonResponse({
                'id': 'j',
                'type': 't',
                'status': 'succeeded',
                'progress': 1,
                'result': {'rows': 10}
              }),
          () => jsonResponse({'id': 'j2', 'type': 't', 'status': 'failed', 'error': 'bad data'}),
        ]),
        apiKey: 'k');
    final seen = <String>[];
    final job = await ap.jobs.wait('j', interval: const Duration(milliseconds: 100), onProgress: (j) => seen.add(j.status));
    expect(seen, ['queued', 'running', 'succeeded']);
    expect(job.result, {'rows': 10});
    expect(sleeps, [const Duration(milliseconds: 100), const Duration(milliseconds: 150)]);
    await expectLater(ap.jobs.wait('j2'), throwsA(isA<JobFailedException>().having((e) => e.job.error, 'error', 'bad data')));
  });

  test('batch result, OpenAPI, dashboards and widget data', () async {
    final ap = client(
        queue([
          () => http.Response('id,prediction\n1,yes\n', 200, headers: {'content-type': 'text/csv'}),
          () => jsonResponse({
                'openapi': '3.1.0',
                'paths': {'/predict': {}}
              }),
          () => jsonResponse({
                'id': 'd1',
                'name': 'Sales',
                'owner_id': 'u1',
                'archived': false,
                'your_role': 'viewer',
                'shares': {},
                'spec': {
                  'pages': [
                    {
                      'id': 'p1',
                      'title': 'Overview',
                      'widgets': [
                        {
                          'id': 'w1',
                          'type': 'kpi',
                          'title': 'Revenue',
                          'config': {'measure': 'amount'}
                        }
                      ]
                    }
                  ],
                  'filters': []
                }
              }),
          () => jsonResponse({
                'columns': ['region', 'total'],
                'rows': [
                  ['eu', 10],
                  ['us', 20]
                ],
                'dataset_version': 3
              }),
        ]),
        apiKey: 'k');
    expect(utf8.decode(await ap.endpoints.batchResult('churn', 'j1')), 'id,prediction\n1,yes\n');
    expect((await ap.endpoints.openApi('churn'))['openapi'], '3.1.0');
    final dash = await ap.dashboards.get('d1');
    expect(dash.widgets.map((w) => w.id), ['w1']);
    final data = await ap.dashboards.widgetData('d1', 'w1', filters: {
      'region': ['eu', 'us']
    });
    expect(data.columns, ['region', 'total']);
    expect(data.rows[1][1], 20);
    expect(data.raw['dataset_version'], 3);
    expect(requests[3].url.path, '/v1/dashboards/d1/widgets/w1/data');
    expect(bodyOf(requests[3]), {
      'filters': {
        'region': ['eu', 'us']
      }
    });
  });

  test('notifications, preferences and logout', () async {
    final store = InMemoryTokenStore(const Tokens(accessToken: 'a', refreshToken: 'r1'));
    final ap = client(
        queue([
          () => jsonResponse([
                {
                  'id': 'n1',
                  'kind': 'job.failed',
                  'title': 'Training failed',
                  'body': {'job_id': 'j1'},
                  'read': false
                }
              ]),
          () => http.Response('', 204),
          () => jsonResponse({
                'email': ['job.failed']
              }),
          () => http.Response('', 204),
        ]),
        store: store);
    final notes = await ap.notifications.list(unreadOnly: true);
    expect(notes.single.body['job_id'], 'j1');
    expect(requests[0].url.query, 'unread_only=true');
    expect(requests[0].headers['Authorization'], 'Bearer a');
    await ap.notifications.markRead('n1');
    expect(await ap.notifications.setPreferences(['job.failed']), ['job.failed']);
    expect(requests[2].method, 'PUT');
    await ap.auth.logout();
    expect(bodyOf(requests[3]), {'refresh_token': 'r1'});
    expect(await store.load(), isNull);
  });

  test('Retry-After parsing and URLs', () {
    expect(Transport.parseRetryAfter('1.5'), const Duration(milliseconds: 1500));
    expect(Transport.parseRetryAfter('soon'), isNull);
    expect(Transport.parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), Duration.zero);
    final t = Transport(ClientConfig(baseUrl: Uri.parse('https://api.test/base/')));
    expect(t.url('/v1/endpoints/churn%20model', {'hours': 6, 'x': null}).toString(),
        'https://api.test/base/v1/endpoints/churn%20model?hours=6');
  });
}

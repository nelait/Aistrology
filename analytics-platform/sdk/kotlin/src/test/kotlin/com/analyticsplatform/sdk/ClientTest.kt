package com.analyticsplatform.sdk

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientTest {
    private lateinit var server: MockWebServer
    private val sleeps = mutableListOf<Long>()

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    private fun client(apiKey: String? = null, store: TokenStore = InMemoryTokenStore(), maxRetries: Int = 3) = AnalyticsPlatformClient(
        ClientConfig(
            server.url("/").toString(),
            apiKey = apiKey,
            tokenStore = store,
            maxRetries = maxRetries,
            timeoutMillis = 5_000,
            sleeper = { sleeps.add(it) },
        ),
    )

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun tokens(n: Int) = """{"access_token":"access-$n","refresh_token":"refresh-$n","expires_in":900,"token_type":"bearer"}"""

    @Test
    fun `api key is sent as X-API-Key and errors are typed`() = runBlocking {
        server.enqueue(json("""[{"id":"e1","name":"churn","status":"active","routes":[{"model_version_id":"mv1","weight":100}]}]"""))
        server.enqueue(json("""{"detail":{"code":"bad_features","message":"missing feature: plan"}}""", 422))
        server.enqueue(json("""{"detail":"endpoint nope not found"}""", 404))
        val ap = client(apiKey = "ap_live_123")

        val endpoints = ap.endpoints.list()
        assertEquals("churn", endpoints.single().name)
        assertEquals("mv1", endpoints.single().routes.single().modelVersionId)
        val first = server.takeRequest()
        assertEquals("ap_live_123", first.getHeader("X-API-Key"))
        assertNull(first.getHeader("Authorization"))

        val invalid = assertFailsWith<ValidationException> { ap.endpoints.predict("churn", listOf(jsonObjectOf("age" to 3))) }
        assertEquals("bad_features", invalid.code)
        assertTrue(invalid.message!!.contains("missing feature: plan"))
        val missing = assertFailsWith<NotFoundException> { ap.endpoints.get("nope") }
        assertEquals(404, missing.status)
    }

    @Test
    fun `login persists tokens and refresh rotates them once for concurrent 401s`() = runBlocking {
        val store = InMemoryTokenStore()
        val refreshes = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            @Volatile var current = "access-1"
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/auth/login" -> json(tokens(1))
                "/v1/auth/refresh" -> {
                    val n = refreshes.incrementAndGet() + 1
                    assertTrue(request.body.readUtf8().contains("\"refresh_token\":\"refresh-1\""))
                    current = "access-$n"
                    json(tokens(n))
                }
                else -> if (request.getHeader("Authorization") == "Bearer $current" && current != "access-1") {
                    json("""{"tenant_id":"acme","id":"u1","role":"admin","method":"jwt"}""")
                } else {
                    json("""{"detail":{"code":"token_expired"}}""", 401)
                }
            }
        }
        val ap = client(store = store)
        val pair = ap.auth.login("ada@acme.example", "Correct-Horse-9", totp = "123456")
        assertEquals("refresh-1", pair.refreshToken)
        assertEquals("access-1", store.load()!!.accessToken)

        // The access token is already expired server side: three concurrent calls share one refresh.
        val results = (1..3).map { async { ap.auth.me() } }.awaitAll()
        assertEquals(listOf("u1", "u1", "u1"), results.map { it.id })
        assertEquals(1, refreshes.get())
        assertEquals(Tokens("access-2", "refresh-2", 900, "bearer"), store.load())
        val login = server.takeRequest()
        assertNull(login.getHeader("Authorization"))
        assertEquals("""{"email":"ada@acme.example","password":"Correct-Horse-9","totp":"123456"}""", login.body.readUtf8())
    }

    @Test
    fun `a rejected refresh token clears the session`() = runBlocking {
        val store = InMemoryTokenStore(Tokens("stale", "used-refresh"))
        server.enqueue(json("""{"detail":"expired"}""", 401))
        server.enqueue(json("""{"detail":{"code":"token_reuse"}}""", 401))
        val ap = client(store = store)
        val err = assertFailsWith<AuthenticationException> { ap.auth.me() }
        assertEquals("token_reuse", err.code)
        assertNull(store.load())
        assertEquals(false, ap.auth.isLoggedIn())
    }

    @Test
    fun `sessions restored from a token store are used`() = runBlocking {
        server.enqueue(json("[]"))
        val ap = client(store = InMemoryTokenStore(Tokens("restored", "r")))
        ap.notifications.list(unreadOnly = true)
        val req = server.takeRequest()
        assertEquals("Bearer restored", req.getHeader("Authorization"))
        assertEquals("/v1/notifications?unread_only=true", req.path)
    }

    @Test
    fun `predict is idempotent and retried on 5xx, honoring Retry-After`() = runBlocking {
        server.enqueue(json("""{"detail":"boom"}""", 502))
        server.enqueue(json("""{"detail":"slow down"}""", 429).setHeader("Retry-After", "2"))
        server.enqueue(json("""{"predictions":["yes"],"probabilities":[[0.2,0.8]],"classes":["no","yes"],"model_version":{"model_id":"m1","version":3}}"""))
        val out = client(apiKey = "k").endpoints.predictRows("churn", listOf(mapOf("tenure" to 3, "plan" to "pro", "vip" to null)))
        assertEquals(listOf<String?>("yes"), out.labels())
        assertEquals(3, out.modelVersion!!.version)
        assertEquals(3, server.requestCount)
        assertEquals(2_000L, sleeps[1])
        assertEquals("""{"instances":[{"tenure":3,"plan":"pro","vip":null}],"explain":false}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `batch uploads are not retried on 5xx but are on 503`() = runBlocking {
        server.enqueue(json("""{"detail":"boom"}""", 500))
        val ap = client(apiKey = "k")
        assertFailsWith<ServerException> { ap.endpoints.batch("churn", "a,b\n1,2\n".toByteArray()) }
        assertEquals(1, server.requestCount)

        server.enqueue(json("""{"detail":"busy"}""", 503))
        server.enqueue(json("""{"id":"j1","type":"serving.batch_predict","status":"queued"}"""))
        val job = ap.endpoints.batch("churn", "a,b\n1,2\n".toByteArray(), "customers.csv")
        assertEquals("j1", job.id)
        server.takeRequest()
        val upload = server.takeRequest()
        assertTrue(upload.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        assertTrue(upload.body.readUtf8().contains("filename=\"customers.csv\""))
    }

    @Test
    fun `connection failures are retried, then surface as NetworkException`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        server.enqueue(json("""{"id":"j1","type":"t","status":"running","progress":0.5}"""))
        assertEquals("running", client(apiKey = "k").jobs.get("j1").status)

        repeat(2) { server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)) }
        val err = assertFailsWith<NetworkException> { client(apiKey = "k", maxRetries = 1).jobs.get("j1") }
        assertTrue(err.message!!.contains("/v1/jobs/j1"))
    }

    @Test
    fun `rate limit errors carry retryAfterSeconds when retries run out`() = runBlocking {
        server.enqueue(json("""{"detail":"rate limit exceeded"}""", 429).setHeader("Retry-After", "7"))
        val err = assertFailsWith<RateLimitException> { client(apiKey = "k", maxRetries = 0).jobs.list() }
        assertEquals(7.0, err.retryAfterSeconds)
    }

    @Test
    fun `anomaly and forecast responses are typed`() = runBlocking {
        server.enqueue(json("""{"predictions":[{"is_anomaly":true,"score":0.91},{"is_anomaly":false,"score":0.12}],"threshold":0.5,"model_version":{"model_id":"m","version":1}}"""))
        server.enqueue(json("""{"horizon":2,"timestamps":["2026-10-01","2026-10-02"],"predictions":[10.5,11.0],"lower":[9.0,9.2],"upper":[12.0,12.8],"interval_level":0.9,"model_version":{"model_id":"f","version":2}}"""))
        val ap = client(apiKey = "k")
        val anomalies = ap.endpoints.predict("fraud", listOf(jsonObjectOf("amount" to 9000)))
        assertEquals(listOf(AnomalyPrediction(true, 0.91), AnomalyPrediction(false, 0.12)), anomalies.anomalies())
        assertEquals(0.5, anomalies.threshold)
        val forecast = ap.endpoints.forecast("sales", horizon = 2, history = listOf(jsonObjectOf("timestamp" to "2026-09-30", "value" to 10)))
        assertEquals(listOf(10.5, 11.0), forecast.predictions)
        assertEquals(0.9, forecast.intervalLevel)
        server.takeRequest()
        assertEquals("""{"horizon":2,"history":[{"timestamp":"2026-09-30","value":10}],"explain":false}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `jobs wait polls with growing intervals and throws on failure`() = runBlocking {
        server.enqueue(json("""{"id":"j","type":"t","status":"queued"}"""))
        server.enqueue(json("""{"id":"j","type":"t","status":"running","progress":0.5}"""))
        server.enqueue(json("""{"id":"j","type":"t","status":"succeeded","progress":1.0,"result":{"rows":10}}"""))
        val seen = mutableListOf<String>()
        val ap = client(apiKey = "k")
        val job = ap.jobs.wait("j", intervalMillis = 100, onProgress = { seen.add(it.status) })
        assertEquals(listOf("queued", "running", "succeeded"), seen)
        assertEquals(JsonPrimitive(10), job.result!!["rows"])
        assertEquals(listOf(100L, 150L), sleeps)

        server.enqueue(json("""{"id":"j2","type":"t","status":"failed","error":"bad data"}"""))
        val failed = assertFailsWith<JobFailedException> { ap.jobs.wait("j2") }
        assertEquals("bad data", failed.job.error)
    }

    @Test
    fun `batch result, openapi, dashboards and widget data`() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/csv").setBody("id,prediction\n1,yes\n"))
        server.enqueue(json("""{"openapi":"3.1.0","paths":{"/predict":{}}}"""))
        server.enqueue(
            json(
                """{"id":"d1","name":"Sales","owner_id":"u1","archived":false,"your_role":"viewer","shares":{},
                   "spec":{"pages":[{"id":"p1","title":"Overview","widgets":[{"id":"w1","type":"kpi","title":"Revenue","config":{"measure":"amount"}}]}],"filters":[]}}""",
            ),
        )
        server.enqueue(json("""{"columns":["region","total"],"rows":[["eu",10],["us",20]],"dataset_version":3}"""))
        val ap = client(apiKey = "k")
        assertEquals("id,prediction\n1,yes\n", String(ap.endpoints.batchResult("churn", "j1")))
        assertEquals("3.1.0", ap.endpoints.openapi("churn")["openapi"]!!.jsonPrimitive.content)
        val dash = ap.dashboards.get("d1")
        assertEquals(listOf("w1"), dash.spec.widgets.map { it.id })
        val data = ap.dashboards.widgetData("d1", "w1", jsonObjectOf("region" to listOf("eu", "us")))
        assertEquals(listOf("region", "total"), data.columns)
        assertEquals("20", data.rows[1][1].jsonPrimitive.content)
        assertEquals(3, data.raw["dataset_version"]!!.jsonPrimitive.content.toInt())
        repeat(3) { server.takeRequest() }
        val widgetReq = server.takeRequest()
        assertEquals("/v1/dashboards/d1/widgets/w1/data", widgetReq.path)
        assertEquals("""{"filters":{"region":["eu","us"]}}""", widgetReq.body.readUtf8())
    }

    @Test
    fun `notifications and preferences`() = runBlocking {
        server.enqueue(json("""[{"id":"n1","kind":"job.failed","title":"Training failed","body":{"job_id":"j1"},"read":false}]"""))
        server.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(json("""{"email":["job.failed","endpoint.threshold"]}"""))
        val ap = client(store = InMemoryTokenStore(Tokens("a", "r")))
        val notes = ap.notifications.list()
        assertEquals("j1", notes.single().body["job_id"]!!.jsonPrimitive.content)
        ap.notifications.markRead("n1")
        val prefs = ap.notifications.setPreferences(listOf("job.failed", "endpoint.threshold"))
        assertEquals(2, prefs.email.size)
        server.takeRequest()
        assertEquals("/v1/notifications/n1/read", server.takeRequest().path)
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("""{"email":["job.failed","endpoint.threshold"]}""", put.body.readUtf8())
    }

    @Test
    fun `logout revokes the refresh token and clears the store`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        val store = InMemoryTokenStore(Tokens("a", "r1"))
        client(store = store).auth.logout()
        assertEquals("""{"refresh_token":"r1"}""", server.takeRequest().body.readUtf8())
        assertNull(store.load())
    }

    @Test
    fun `escape hatch and retry-after parsing`() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        val out = client(apiKey = "k").request("GET", "/v1/tenant/usage", mapOf("since" to "2026-01-01"))
        assertEquals(JsonPrimitive(true), out!!.jsonObject["ok"])
        assertEquals("/v1/tenant/usage?since=2026-01-01", server.takeRequest().path)
        assertEquals(1.5, Transport.parseRetryAfter("1.5"))
        assertNull(Transport.parseRetryAfter("soon"))
        assertTrue(Transport.parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0)
        assertEquals(JsonObject(emptyMap()), emptyMap<String, Any?>().toJsonObject())
        assertEquals(2, listOf(1, "a").toJsonElement().jsonArray.size)
    }
}

"""gRPC inference server (API-004), a separate process: ``python -m app.serving.grpc_server [--port 50051]``.

Implements ``ap.v1.Predictor/Predict`` from ``protos/predict.proto``. The messages are ``google.protobuf.Struct``, so
the server needs no generated code (clients can generate stubs from the ``.proto``). Authentication is by metadata:
``x-api-key`` (or ``authorization: Bearer …``), checked exactly like the REST API: key validity / expiry / IP allowlist,
tenant IP policy (MGT-007), the ``endpoints.predict`` permission (scopes included) and the per-key rate limit (MGT-002).
Predictions go through ``ServingService.predict``, so logging, metering and drift sampling are shared with REST.
"""

from __future__ import annotations

import argparse
import logging
from concurrent import futures
from typing import TYPE_CHECKING, Any

import grpc
from google.protobuf import json_format, struct_pb2

from ..auth.rbac import Permission, has_permission
from ..auth.service import AuthError, Principal
from ..export_utils import jsonable

if TYPE_CHECKING:  # pragma: no cover
    from ..api.deps import AppState

log = logging.getLogger("app.serving.grpc")
SERVICE = "ap.v1.Predictor"
MAX_MESSAGE_BYTES = 16 * 1024 * 1024


def _peer_ip(context: grpc.ServicerContext) -> str | None:
    peer = context.peer() or ""
    kind, _, rest = peer.partition(":")
    if kind == "ipv4":
        return rest.rsplit(":", 1)[0]
    if kind == "ipv6":
        return rest.rsplit(":", 1)[0].strip("[]")
    return None


def _authenticate(state: AppState, context: grpc.ServicerContext) -> Principal:
    from ..api.deps import SCOPED_METHODS
    from ..auth.network import network_allows
    from ..auth.oauth import OAuthService, is_oauth_token

    meta = {k.lower(): v for k, v in (context.invocation_metadata() or [])}
    ip = _peer_ip(context)
    key = meta.get("x-api-key")
    auth = meta.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else None
    try:
        if key or (token and token.startswith("ap_")):
            principal = state.auth.verify_api_key(key or token, ip)
        elif token and is_oauth_token(token):
            principal = OAuthService(state).verify_token(token)
        elif token:
            principal = state.auth.verify_access_token(token)
        else:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "send x-api-key (or authorization: Bearer) metadata")
    except AuthError as exc:
        context.abort(grpc.StatusCode.UNAUTHENTICATED, str(exc))
    if not network_allows(state, principal.tenant_id, ip):
        context.abort(grpc.StatusCode.PERMISSION_DENIED, "access from this IP address is not allowed")
    if not has_permission(principal.role, Permission.PREDICT, principal.scopes if principal.method in SCOPED_METHODS else None):
        context.abort(grpc.StatusCode.PERMISSION_DENIED, "missing permission endpoints.predict")
    if not state.rate_limiter.allow(f"{principal.tenant_id}:{principal.user_id}", principal.rate_limit_per_minute or 1200):
        context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limit exceeded")
    return principal


class Predictor:
    def __init__(self, state: AppState):
        self.state = state

    def predict(self, request: struct_pb2.Struct, context: grpc.ServicerContext) -> struct_pb2.Struct:
        from ..serving.service import ServingError, ServingService
        from ..training.service import NotFound

        principal = _authenticate(self.state, context)
        body: dict[str, Any] = json_format.MessageToDict(request)
        endpoint = body.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "endpoint is required")
        instances = body.get("instances")
        if instances is not None and (not isinstance(instances, list) or not all(isinstance(r, dict) for r in instances)):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "instances must be a list of objects")
        horizon = body.get("horizon")
        try:
            out = ServingService(self.state).predict(
                principal.tenant_id,
                endpoint,
                instances,
                explain=bool(body.get("explain")),
                caller=principal.user_id,
                horizon=int(horizon) if horizon is not None else None,
                history=body.get("history"),
            )
        except NotFound as exc:
            context.abort(grpc.StatusCode.NOT_FOUND, f"not found: {exc}")
        except (ServingError, ValueError) as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
        except Exception:  # noqa: BLE001 - never leak internals
            log.exception("gRPC predict failed")
            context.abort(grpc.StatusCode.INTERNAL, "prediction failed")
        response = struct_pb2.Struct()
        response.update(jsonable(out))
        return response


def build_server(state: AppState, port: int = 50051, *, workers: int = 8, host: str = "[::]") -> tuple[grpc.Server, int]:
    predictor = Predictor(state)
    handler = grpc.method_handlers_generic_handler(
        SERVICE,
        {
            "Predict": grpc.unary_unary_rpc_method_handler(
                predictor.predict,
                request_deserializer=struct_pb2.Struct.FromString,
                response_serializer=struct_pb2.Struct.SerializeToString,
            )
        },
    )
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=workers),
        options=[("grpc.max_receive_message_length", MAX_MESSAGE_BYTES), ("grpc.max_send_message_length", MAX_MESSAGE_BYTES)],
    )
    server.add_generic_rpc_handlers((handler,))
    bound = server.add_insecure_port(f"{host}:{port}")  # terminate TLS at the load balancer / mesh, like the REST API
    return server, bound


def main(argv: list[str] | None = None) -> None:  # pragma: no cover - process entrypoint
    from ..api.deps import build_state

    parser = argparse.ArgumentParser(description="Analytics Platform gRPC inference server (API-004)")
    parser.add_argument("--port", type=int, default=50051)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO)
    server, port = build_server(build_state(), args.port, workers=args.workers)
    server.start()
    log.info("gRPC Predictor listening on port %s", port)
    server.wait_for_termination()


if __name__ == "__main__":  # pragma: no cover
    main()

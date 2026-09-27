"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SignatureField } from "@/lib/api";
import { openapiFields, signatureFields } from "@/lib/signature";

/** Input fields for an endpoint: from the served model version's signature, else its OpenAPI document. */
export function useEndpointFields(endpointName: string | undefined): { fields: SignatureField[]; loading: boolean } {
  const ep = useQuery({ queryKey: ["endpoint", endpointName], queryFn: () => api.endpoints.get(endpointName!), enabled: !!endpointName, meta: { silent: true } });
  const model = useQuery({ queryKey: ["model", ep.data?.model_id], queryFn: () => api.models.get(ep.data!.model_id), enabled: !!ep.data?.model_id, meta: { silent: true } });
  const openapi = useQuery({ queryKey: ["openapi", endpointName], queryFn: () => api.endpoints.openapi(endpointName!), enabled: !!endpointName, meta: { silent: true } });
  const fields = useMemo(() => {
    const versions = model.data?.versions ?? [];
    const v = versions.find((x) => x.version === ep.data?.version) ?? versions.find((x) => x.stage === "production") ?? versions[versions.length - 1];
    const fromSig = v ? signatureFields(v.signature) : [];
    return fromSig.length ? fromSig : openapiFields(openapi.data);
  }, [model.data, openapi.data, ep.data]);
  return { fields, loading: ep.isLoading || model.isLoading };
}

import {
  type ApiKeyCreds,
  Chain,
  ClobClient,
  type SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

import type { BotConfig } from "./types.js";

export async function createLiveClobClient(config: BotConfig): Promise<ClobClient> {
  if (!config.privateKey || !config.funderAddress) {
    throw new Error("Live CLOB client requires wallet private key and funder address.");
  }

  const account = privateKeyToAccount(config.privateKey);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.polygonRpcUrl),
  });
  const signatureType = config.signatureType as SignatureTypeV2;

  const tempClient = new ClobClient({
    host: config.clobHost,
    chain: Chain.POLYGON,
    signer,
    signatureType,
    funderAddress: config.funderAddress,
  });
  const creds = (await tempClient.createOrDeriveApiKey()) as unknown;
  if (!isApiKeyCreds(creds)) {
    throw new Error(`Could not create or derive Polymarket API key${formatApiKeyFailure(creds)}.`);
  }

  return new ClobClient({
    host: config.clobHost,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType,
    funderAddress: config.funderAddress,
    throwOnError: true,
  });
}

export class LiveClobClientProvider {
  private clientPromise?: Promise<ClobClient>;

  constructor(private readonly config: BotConfig) {}

  getClient(): Promise<ClobClient> {
    this.clientPromise ??= createLiveClobClient(this.config);
    return this.clientPromise;
  }
}

function isApiKeyCreds(value: unknown): value is ApiKeyCreds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    record.key.length > 0 &&
    typeof record.secret === "string" &&
    record.secret.length > 0 &&
    typeof record.passphrase === "string" &&
    record.passphrase.length > 0
  );
}

function formatApiKeyFailure(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  const error = typeof record.error === "string" ? record.error : undefined;
  const status = typeof record.status === "number" ? record.status : undefined;
  if (!error && status === undefined) {
    return "";
  }
  return ` (${[status ? `status ${status}` : undefined, error].filter(Boolean).join(": ")})`;
}

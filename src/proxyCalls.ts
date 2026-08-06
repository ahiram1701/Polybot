import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

/**
 * Constructores de llamadas para el MINT-arb, que necesita ESCRIBIR en cadena — lo primero que hace
 * Polybot fuera de leer saldo.
 *
 * El detalle que lo condiciona todo: **el colateral no vive en la cuenta que firma**. Con
 * `POLYMARKET_SIGNATURE_TYPE=1` los fondos estan en un *proxy wallet* de Polymarket (aqui
 * `0xa3bE...8A76`, un clon EIP-1167), y la EOA derivada de la clave solo firma. Verificado on-chain:
 * la EOA tiene $0,00 de pUSD y el proxy $17,80. Llamar `splitPosition` directamente desde la EOA
 * revertiria por saldo cero.
 *
 * Por eso toda escritura se envuelve en el punto de entrada por lotes del proxy,
 * `proxy((uint8,address,uint256,bytes)[])`. Esa firma NO esta en el SDK de Polymarket: se confirmo
 * probando el bytecode de la implementacion (`0x44e999...eb4f`), donde aparece su selector `0x34ee9791`
 * y no el de las variantes alternativas. El selector depende del orden exacto de los campos, asi que
 * encajar el selector confirma la firma.
 *
 * Este modulo es PURO: construye calldata y no envia nada. Lo que no se puede verificar sin gas
 * (autorizacion del proxy, limites, revert real) queda fuera a proposito.
 */

/** Contrato de tokens condicionales en Polygon, via `getContractConfig(137)` del SDK. */
export const CONDITIONAL_TOKENS_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;

/** Punto de entrada por lotes del proxy wallet. Selector 0x34ee9791. */
export const PROXY_ABI = [
  {
    type: "function",
    name: "proxy",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "typeCode", type: "uint8" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes[]" }],
  },
] as const;

export const CONDITIONAL_TOKENS_ABI = [
  {
    type: "function",
    name: "splitPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

export interface ProxyCall {
  typeCode: number;
  to: Address;
  value: bigint;
  data: Hex;
}

/** `CALL` normal. El proxy admite otros modos; acuñar y aprobar no necesitan ninguno. */
const CALL_TYPE_CODE = 0;

function call(to: Address, data: Hex): ProxyCall {
  return { typeCode: CALL_TYPE_CODE, to, value: 0n, data };
}

/**
 * Mercado binario: la particion es siempre `[1, 2]` — un bit por resultado. Acuñar `amount` entrega
 * `amount` participaciones de CADA lado a cambio de `amount` de colateral, por eso un set cuesta
 * exactamente $1 y redime exactamente $1.
 */
export const BINARY_PARTITION = [1n, 2n] as const;

/** El id de coleccion padre es cero salvo en mercados anidados; estos no lo son. */
export const ROOT_COLLECTION_ID = `0x${"0".repeat(64)}` as Hex;

export function buildSplitPositionCall(args: {
  collateral: Address;
  conditionId: Hex;
  /** Sets a acuñar, en unidades del colateral (pUSD tiene 6 decimales). */
  amount: bigint;
  conditionalTokens?: Address;
}): ProxyCall {
  return call(
    args.conditionalTokens ?? CONDITIONAL_TOKENS_ADDRESS,
    encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: "splitPosition",
      args: [args.collateral, ROOT_COLLECTION_ID, args.conditionId, [...BINARY_PARTITION], args.amount],
    }),
  );
}

/** Permiso para que el contrato de tokens condicionales gaste el colateral DEL PROXY. */
export function buildCollateralApprovalCall(args: {
  collateral: Address;
  amount: bigint;
  conditionalTokens?: Address;
}): ProxyCall {
  return call(
    args.collateral,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [args.conditionalTokens ?? CONDITIONAL_TOKENS_ADDRESS, args.amount],
    }),
  );
}

/** Permiso para que el exchange mueva las participaciones acuñadas, necesario para venderlas. */
export function buildSharesApprovalCall(args: { exchange: Address; conditionalTokens?: Address }): ProxyCall {
  return call(
    args.conditionalTokens ?? CONDITIONAL_TOKENS_ADDRESS,
    encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: "setApprovalForAll",
      args: [args.exchange, true],
    }),
  );
}

/** Envuelve el lote para enviarlo AL PROXY. Es el unico destino valido: la EOA no tiene fondos. */
export function encodeProxyBatch(calls: readonly ProxyCall[]): Hex {
  if (calls.length === 0) {
    throw new Error("Lote de proxy vacio: enviarlo gastaria gas sin hacer nada.");
  }
  return encodeFunctionData({ abi: PROXY_ABI, functionName: "proxy", args: [calls] });
}

/** Convierte dolares a unidades del colateral. pUSD tiene 6 decimales, como USDC. */
export function toCollateralUnits(usd: number, decimals = 6): bigint {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`Importe invalido para acuñar: ${usd}`);
  }
  // Trunca en vez de redondear: acuñar mas de lo que se puede pagar revierte la transaccion entera.
  return BigInt(Math.floor(usd * 10 ** decimals));
}

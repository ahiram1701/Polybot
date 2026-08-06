import { decodeFunctionData, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import {
  BINARY_PARTITION,
  CONDITIONAL_TOKENS_ADDRESS,
  PROXY_ABI,
  ROOT_COLLECTION_ID,
  buildCollateralApprovalCall,
  buildSharesApprovalCall,
  buildSplitPositionCall,
  encodeProxyBatch,
  toCollateralUnits,
} from "../src/proxyCalls.js";

const COLLATERAL = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
const CONDITION = `0x${"ab".repeat(32)}` as const;

describe("llamadas via proxy wallet", () => {
  /**
   * El selector depende del orden EXACTO de los campos del struct, asi que encajar con el que aparece
   * en el bytecode de la implementacion del proxy (0x44e999...eb4f) es lo que confirma la firma —
   * no esta documentada ni la expone el SDK.
   */
  it("el punto de entrada del proxy es el selector 0x34ee9791 observado en el contrato", () => {
    expect(toFunctionSelector("proxy((uint8,address,uint256,bytes)[])")).toBe("0x34ee9791");
    expect(encodeProxyBatch([buildSplitPositionCall({ collateral: COLLATERAL, conditionId: CONDITION, amount: 1n })])
      .slice(0, 10)).toBe("0x34ee9791");
  });

  it("acuñar usa la particion binaria y la coleccion raiz", () => {
    const { data, to, value } = buildSplitPositionCall({
      collateral: COLLATERAL,
      conditionId: CONDITION,
      amount: 17_000_000n,
    });
    expect(to).toBe(CONDITIONAL_TOKENS_ADDRESS);
    // Acuñar no envia POL: el coste es el colateral, que se mueve como ERC20.
    expect(value).toBe(0n);
    const decoded = decodeFunctionData({
      abi: [
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
      ] as const,
      data,
    });
    expect(decoded.args[0]).toBe(COLLATERAL);
    expect(decoded.args[1]).toBe(ROOT_COLLECTION_ID);
    expect(decoded.args[2]).toBe(CONDITION);
    expect(decoded.args[3]).toEqual([...BINARY_PARTITION]);
    expect(decoded.args[4]).toBe(17_000_000n);
  });

  it("los dos permisos apuntan a los contratos correctos", () => {
    // El colateral lo gasta el contrato de tokens condicionales al acuñar...
    expect(buildCollateralApprovalCall({ collateral: COLLATERAL, amount: 1n }).to).toBe(COLLATERAL);
    // ...y las participaciones las mueve el exchange al venderlas.
    expect(buildSharesApprovalCall({ exchange: EXCHANGE }).to).toBe(CONDITIONAL_TOKENS_ADDRESS);
  });

  it("el lote conserva el orden: aprobar ANTES de acuñar, o el acuñado revierte", () => {
    const calls = [
      buildCollateralApprovalCall({ collateral: COLLATERAL, amount: 17_000_000n }),
      buildSplitPositionCall({ collateral: COLLATERAL, conditionId: CONDITION, amount: 17_000_000n }),
    ];
    const decoded = decodeFunctionData({ abi: PROXY_ABI, data: encodeProxyBatch(calls) });
    const lote = decoded.args[0] as ReadonlyArray<{ to: string }>;
    expect(lote).toHaveLength(2);
    expect(lote[0].to).toBe(COLLATERAL);
    expect(lote[1].to).toBe(CONDITIONAL_TOKENS_ADDRESS);
  });

  it("un lote vacio no se envia: gastaria gas sin hacer nada", () => {
    expect(() => encodeProxyBatch([])).toThrow(/vacio/i);
  });

  describe("conversion de dolares a unidades de colateral", () => {
    it("usa los 6 decimales de pUSD", () => {
      expect(toCollateralUnits(17)).toBe(17_000_000n);
      expect(toCollateralUnits(0.5)).toBe(500_000n);
    });

    it("trunca en vez de redondear: pasarse de saldo revierte la transaccion entera", () => {
      expect(toCollateralUnits(1.9999999)).toBe(1_999_999n);
    });

    it("rechaza importes que no son un numero positivo", () => {
      expect(() => toCollateralUnits(0)).toThrow();
      expect(() => toCollateralUnits(-1)).toThrow();
      expect(() => toCollateralUnits(Number.NaN)).toThrow();
    });
  });
});

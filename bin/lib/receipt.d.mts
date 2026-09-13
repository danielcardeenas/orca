/**
 * Tipos para `receipt.mjs`, que es JS suelto porque vive en `bin/` y lo ejecuta
 * node directamente, sin pasar por tsx. Esto existe para que la prueba —que sí
 * es TypeScript— pueda importarlo sin apagar `noImplicitAny` a su alrededor.
 * Mismo motivo y misma forma que `whoami.d.mts`.
 */

export type ReceiptState = 'filed' | 'picked' | 'delivered' | 'undeliverable' | 'read';

export interface Receipt {
  msgId: string;
  state: ReceiptState;
  to: string;
  kind: string;
  recipients: string[];
  detail: string | null;
  at: number;
  updatedAt: number;
}

export declare const RECEIPT_STATES: ReceiptState[];
export declare const PICKUP_GRACE_MS: number;
export declare const RECEIPT_TTL_MS: number;

export declare function receiptsDir(root: string): string;
export declare function receiptPath(dir: string, stem: string): string;
export declare function readReceipt(dir: string, stem: string): Receipt | null;
export declare function writeReceipt(dir: string, stem: string, receipt: Receipt): boolean;
export declare function describeReceipt(receipt: Receipt | null, now?: number): string;
export declare function sweepReceipts(dir: string, outDir?: string | null, now?: number): Receipt[];

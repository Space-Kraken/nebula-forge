/**
 * Minimal helpers for building Terraform JSON documents. Terraform's JSON
 * syntax is a 1:1 mapping of HCL, so the engine emits plain objects — no
 * CDKTF, no HCL printing, nothing for users to learn or read.
 */

export type TfDocument = {
  terraform: Record<string, unknown>;
  provider: Record<string, unknown>;
  data: Record<string, Record<string, unknown>>;
  resource: Record<string, Record<string, unknown>>;
  output: Record<string, unknown>;
};

export function addResource(
  doc: TfDocument,
  type: string,
  label: string,
  body: Record<string, unknown>,
): string {
  doc.resource[type] = doc.resource[type] ?? {};
  if (doc.resource[type][label]) {
    throw new Error(`duplicate terraform resource ${type}.${label}`);
  }
  doc.resource[type][label] = body;
  return `${type}.${label}`;
}

export function addData(
  doc: TfDocument,
  type: string,
  label: string,
  body: Record<string, unknown>,
): string {
  doc.data[type] = doc.data[type] ?? {};
  doc.data[type][label] = body;
  return `data.${type}.${label}`;
}

/** Terraform interpolation reference: ref('azurerm_x.y', 'id') → "${azurerm_x.y.id}" */
export function ref(address: string, attribute: string): string {
  return `\${${address}.${attribute}}`;
}

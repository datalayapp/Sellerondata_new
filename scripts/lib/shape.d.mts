// shape.mjs için tip bildirimi (TypeScript testleri içe aktarır). Şekil dili shape.mjs başında.
export type Shape = string | Shape[] | { [key: string]: Shape };
export interface ShapeOptions {
  records?: string[];
  opaque?: string[];
}
export function shapeOf(value: unknown, opts?: ShapeOptions, at?: string): Shape;
export function mergeShapes(a: Shape, b: Shape): Shape;
export function compareShape(mock: Shape, real: Shape, opts?: { ignore?: string[] }, at?: string, out?: string[]): string[];

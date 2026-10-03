// Types for run-analyst.mjs (so TypeScript tests and tools can import it).
export type AnalystToken = string | number;

export interface AnalystPath {
  tokens: AnalystToken[];
  moves: number;
  blocked: boolean;
  start: string;
  end: string;
}

export interface AnalystResult {
  paths: AnalystPath[];
  totalMoves: number;
  blocked: boolean;
}

export function loadAnalyst(): unknown;
export function parseCode(code: string): string[][];
export function parseSolution(sol: string): number[][];
export function mapFeatures(board: string[][]): string[];
export function toServerTokens(tokens: string[], start: string, board: string[][]): AnalystToken[];
export function normalizeTokens(tokens: AnalystToken[]): string[];
export function runAnalyst(code: string, solution: string): AnalystResult;

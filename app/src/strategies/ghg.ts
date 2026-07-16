// Greenhouse-gas conversion shared across the results UI, CSV, and PDF report.
//
// GHG emission factor (MOVES Colorado statewide-blended, kg CO2e / VMT).
// Per CDOT modeling team brief. Sub-corridor refinement requires MOVES rates
// by facility class; defer until methodology guide pins those numbers.
export const GHG_KG_PER_VMT = 0.412;

// Annual VMT per typical passenger vehicle, used for the "cars off-road
// equivalent" co-benefit (FHWA ~13,500 mi/yr).
export const ANNUAL_VMT_PER_CAR = 13500;

/** Convert an annual VMT reduction (mi/yr) to metric tonnes CO2e/yr. */
export function annualVmtToGhgTonnes(annualVmt: number): number {
  return (annualVmt * GHG_KG_PER_VMT) / 1000;
}

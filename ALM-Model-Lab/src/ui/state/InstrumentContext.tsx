/**
 * Instrument library state.
 *
 * Lives alongside the rate-domain AppContext rather than being merged into
 * it. Phase 2 stores one Fixed Loan and one Floating Loan; Phase 3+ analytics
 * (Repricing Gap, Liquidity Gap, FTP, SEG/EBP) read the active instruments
 * from this context as their input book.
 *
 * Concrete instrument constructors (FixedLoan / FloatingLoan) are not stored
 * — only the *terms*. The class instance is built on demand when a tab or
 * analytic needs cashflows. This keeps the context a pure data store and
 * sidesteps serialisation pitfalls if we ever want to persist library state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  FIXED_LOAN_DEFAULTS,
  type FixedLoanTerms,
} from "../../math/instruments/fixedLoan";
import {
  FLOATING_LOAN_DEFAULTS,
  type FloatingLoanTerms,
} from "../../math/instruments/floatingLoan";
import {
  MORTGAGE_DEFAULTS,
  type MortgageTerms,
} from "../../math/instruments/mortgage";
import {
  NMD_TERMS_DEFAULTS,
  type NMDTerms,
} from "../../math/instruments/nmd";
import {
  NMD_B_TERMS_DEFAULTS,
  type NMDBetaTerms,
} from "../../math/instruments/nmdBeta";

export interface InstrumentLibrary {
  fixedLoan: FixedLoanTerms;
  floatingLoan: FloatingLoanTerms;
  mortgage: MortgageTerms;
  nmd: NMDTerms;
  nmdBeta: NMDBetaTerms;
}

export interface InstrumentActions {
  setFixedLoan(terms: FixedLoanTerms): void;
  patchFixedLoan(update: Partial<FixedLoanTerms>): void;
  setFloatingLoan(terms: FloatingLoanTerms): void;
  patchFloatingLoan(update: Partial<FloatingLoanTerms>): void;
  setMortgage(terms: MortgageTerms): void;
  patchMortgage(update: Partial<MortgageTerms>): void;
  setNmd(terms: NMDTerms): void;
  patchNmd(update: Partial<NMDTerms>): void;
  setNmdBeta(terms: NMDBetaTerms): void;
  patchNmdBeta(update: Partial<NMDBetaTerms>): void;
}

type InstrumentContextValue = InstrumentLibrary & InstrumentActions;

const Ctx = createContext<InstrumentContextValue | null>(null);

export function InstrumentProvider({ children }: { children: ReactNode }) {
  const [fixedLoan, setFixedLoanState] = useState<FixedLoanTerms>(FIXED_LOAN_DEFAULTS);
  const [floatingLoan, setFloatingLoanState] = useState<FloatingLoanTerms>(FLOATING_LOAN_DEFAULTS);
  const [mortgage, setMortgageState] = useState<MortgageTerms>(MORTGAGE_DEFAULTS);
  const [nmd, setNmdState] = useState<NMDTerms>(NMD_TERMS_DEFAULTS);
  const [nmdBeta, setNmdBetaState] = useState<NMDBetaTerms>(NMD_B_TERMS_DEFAULTS);

  const setFixedLoan = useCallback((t: FixedLoanTerms) => setFixedLoanState(t), []);
  const patchFixedLoan = useCallback((u: Partial<FixedLoanTerms>) => {
    setFixedLoanState((prev) => ({ ...prev, ...u }));
  }, []);
  const setFloatingLoan = useCallback((t: FloatingLoanTerms) => setFloatingLoanState(t), []);
  const patchFloatingLoan = useCallback((u: Partial<FloatingLoanTerms>) => {
    setFloatingLoanState((prev) => ({ ...prev, ...u }));
  }, []);
  const setMortgage = useCallback((t: MortgageTerms) => setMortgageState(t), []);
  const patchMortgage = useCallback((u: Partial<MortgageTerms>) => {
    setMortgageState((prev) => ({ ...prev, ...u }));
  }, []);
  const setNmd = useCallback((t: NMDTerms) => setNmdState(t), []);
  const patchNmd = useCallback((u: Partial<NMDTerms>) => {
    setNmdState((prev) => ({ ...prev, ...u }));
  }, []);
  const setNmdBeta = useCallback((t: NMDBetaTerms) => setNmdBetaState(t), []);
  const patchNmdBeta = useCallback((u: Partial<NMDBetaTerms>) => {
    setNmdBetaState((prev) => ({ ...prev, ...u }));
  }, []);

  const value = useMemo<InstrumentContextValue>(
    () => ({
      fixedLoan,
      floatingLoan,
      mortgage,
      nmd,
      nmdBeta,
      setFixedLoan,
      patchFixedLoan,
      setFloatingLoan,
      patchFloatingLoan,
      setMortgage,
      patchMortgage,
      setNmd,
      patchNmd,
      setNmdBeta,
      patchNmdBeta,
    }),
    [
      fixedLoan,
      floatingLoan,
      mortgage,
      nmd,
      nmdBeta,
      setFixedLoan,
      patchFixedLoan,
      setFloatingLoan,
      patchFloatingLoan,
      setMortgage,
      patchMortgage,
      setNmd,
      patchNmd,
      setNmdBeta,
      patchNmdBeta,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInstruments(): InstrumentContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useInstruments must be used inside InstrumentProvider");
  return ctx;
}

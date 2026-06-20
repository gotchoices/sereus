/**
 * Marks this as a React `act()` environment so `react-test-renderer` does not
 * warn about state updates outside `act(...)` (all our updates ARE wrapped, but
 * React only trusts the flag, not the call site).
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};

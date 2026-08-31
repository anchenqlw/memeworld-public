export function createSingleFlight() {
  let active = false;
  return {
    take() {
      if (active) return false;
      active = true;
      return true;
    },
    release() {
      active = false;
    },
  };
}

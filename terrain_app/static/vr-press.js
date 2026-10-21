// A guard against double taps: a second press on the same panel, at about the same spot, within PRESS_GAP ms of the
// last one is ignored. Tapping an option often opens a new ring with another option under the same fingertip or
// laser dot; a jittery second tap must not choose it. Presses elsewhere (a different key, another panel) still count.
export const PRESS_GAP=100;   // ms
export const PRESS_NEAR=.12;  // how close counts as the same spot: a share of the panel's width…
export const PRESS_NEAR_MIN=.02;   // …but at least this much (m): the watch and wrist button are only a few cm across

export function createPressGuard(gap=PRESS_GAP,near=PRESS_NEAR,nearest=PRESS_NEAR_MIN) {
  let last=null;
  return {
    // `panel` names the surface, `x`/`y` are where on it (in the panel's own units, `width` wide), `now` in ms.
    // True if the press counts; false if it repeats the last one too soon.
    allow({panel,x,y,width,now}) {
      const repeat=last&&last.panel===panel&&now-last.now<gap&&Math.hypot(x-last.x,y-last.y)<Math.max(near*width,nearest);
      if(repeat)return false;
      last={panel,x,y,now};
      return true;
    },
    reset(){last=null;},
  };
}

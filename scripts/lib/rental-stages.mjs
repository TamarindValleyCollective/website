// Where a member's offer to rent out their home stands, in the same four stages for everyone who looks at it: the
// member (My rental), and the admins (Units -> Pipeline). One list and one rule, so the two screens cannot disagree.
// The stepper element itself is rental-stepper.mjs. Plan: docs/plans/accommodation-member-units.md.

export const STAGES = [
  { id: 'offered', label: 'Offered' },
  { id: 'shared', label: 'Contract shared' },
  { id: 'signed', label: 'Signed copy in' },
  { id: 'enabled', label: 'Enabled' },
];

// Index into STAGES of the stage reached, or -1 when there is nothing in progress (no offer, or it was withdrawn or declined).
//   offerStatus:      the offer's status (interested, enabled, withdrawn, declined), if there is one
//   contractStatus:   the contract's status (shared, signed, active, ...), if one was shared
//   unitStatus:       the unit's status (rentable, paused, offboarded), if the offer was enabled
export function stageIndex({ offerStatus, contractStatus, unitStatus } = {}) {
  if (unitStatus === 'rentable' || unitStatus === 'paused') return 3;
  if (offerStatus !== 'interested') return -1;
  if (contractStatus === 'signed') return 2;
  if (contractStatus === 'shared') return 1;
  return 0;
}

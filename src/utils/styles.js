// The original design drives everything through inline style objects rather than
// utility classes. These helpers keep that approach but pull the repeated pieces
// into one place so screens stay readable.

export const navItemBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  width: '100%',
  padding: '11px 13px',
  border: 'none',
  borderRadius: '10px',
  fontSize: '14.5px',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  transition: 'background .15s, color .15s'
}

export function navItemStyle(active) {
  return active
    ? { ...navItemBase, background: '#E9EFF7', color: '#0B3465', fontWeight: '600' }
    : { ...navItemBase, background: 'transparent', color: '#475569', fontWeight: '500' }
}

export const tabBase = {
  padding: '9px 18px',
  borderRadius: '10px',
  border: '1px solid #E2E8F0',
  fontSize: '14px',
  fontWeight: '600',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

export function tabStyle(active) {
  return active
    ? { ...tabBase, background: '#0B3465', color: '#fff', borderColor: '#0B3465' }
    : { ...tabBase, background: '#fff', color: '#475569' }
}

export const radioBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '9px',
  padding: '13px 16px',
  borderRadius: '11px',
  border: '1.5px solid',
  fontSize: '14.5px',
  cursor: 'pointer',
  background: '#fff',
  fontFamily: 'inherit',
  flex: '1',
  justifyContent: 'center'
}

export function radioStyle(active) {
  return active
    ? { ...radioBase, borderColor: '#0B3465', background: '#E9EFF7', color: '#0B3465', fontWeight: '600' }
    : { ...radioBase, borderColor: '#E2E8F0', color: '#475569', fontWeight: '500' }
}

const pillBase = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 11px',
  borderRadius: '999px',
  fontSize: '12.5px',
  fontWeight: '600',
  whiteSpace: 'nowrap'
}

/** `Costing Worksheet.status` — the six values the DocType declares.
 *  Colours follow the brandbook's own status-pill rule: green is approval/
 *  positive movement only (Approved, Quoted), red is Lost, everything else
 *  (Draft, Pending) is a neutral/amber non-outcome. */
const WORKSHEET_STATUS_COLOURS = {
  Draft: { background: '#EDF1F6', color: '#5E6B7A' },
  'Pending BU Head': { background: '#FEF3C7', color: '#B45309' },
  'Pending CFO': { background: '#FEF3C7', color: '#B45309' },
  Approved: { background: 'rgba(16,120,48,.1)', color: '#107830' },
  Quoted: { background: 'rgba(16,120,48,.1)', color: '#107830' },
  Lost: { background: 'rgba(230,57,70,.1)', color: '#E63946' }
}

export const worksheetStatusStyle = (s) => ({ ...pillBase, ...(WORKSHEET_STATUS_COLOURS[s] || {}) })

/** `docstatus` on any submittable DocType: 0 Draft, 1 Submitted, 2 Cancelled. */
const DOCSTATUS_META = {
  0: { label: 'Draft', background: '#EDF1F6', color: '#5E6B7A' },
  1: { label: 'Submitted', background: 'rgba(16,120,48,.1)', color: '#107830' },
  2: { label: 'Cancelled', background: 'rgba(230,57,70,.1)', color: '#E63946' }
}

export function docstatusBadge(docstatus) {
  const meta = DOCSTATUS_META[docstatus] ?? DOCSTATUS_META[0]
  return { label: meta.label, style: { ...pillBase, background: meta.background, color: meta.color } }
}

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
    ? { ...navItemBase, background: '#FFF7ED', color: '#EA580C', fontWeight: '600' }
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
    ? { ...tabBase, background: '#0F172A', color: '#fff', borderColor: '#0F172A' }
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
    ? { ...radioBase, borderColor: '#F97316', background: '#FFF7ED', color: '#9A3412', fontWeight: '600' }
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

/** `Costing Worksheet.status` — the six values the DocType declares. */
const WORKSHEET_STATUS_COLOURS = {
  Draft: { background: '#F1F5F9', color: '#64748B' },
  'Pending BU Head': { background: '#FEF3C7', color: '#B45309' },
  'Pending CFO': { background: '#FEF3C7', color: '#B45309' },
  Approved: { background: '#EFF6FF', color: '#2563EB' },
  Quoted: { background: '#DCFCE7', color: '#15803D' },
  Lost: { background: '#FEE2E2', color: '#DC2626' }
}

export const worksheetStatusStyle = (s) => ({ ...pillBase, ...(WORKSHEET_STATUS_COLOURS[s] || {}) })

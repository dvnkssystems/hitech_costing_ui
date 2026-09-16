/**
 * Splitting one item's order quantity across the containers it needs.
 *
 * This is the ONLY container-fit arithmetic the client does itself --
 * whether / how a tank fits (units per container, orientation, gaps, weight
 * cap) always comes from the backend's `preview_container_fit().layout` or a
 * saved Container Fit Plan payload. Shared by the wizard's Container /
 * Logistics per-container table and the 3D dialog's container list, so the
 * two can never disagree on "how many in container N" or its utilization.
 *
 * Every container is filled to `unitsPerContainer` except the last, which
 * takes the remainder. Utilization is by volume: tanks loaded × tank volume
 * ÷ container volume.
 *
 * Both the wizard and the 3D dialog only fall back to `containerBreakdown()`
 * when the backend didn't return its own per-container split
 * (`preview_container_fit` / `preview_fit_plan`'s `containers`, which honours
 * per-container gap / pallet overrides).
 */

/** L × W × H in mm³ of a `{ length_mm, width_mm, height_mm }` box; 0 when
 *  missing. */
export function boxVolume(box) {
  if (!box) return 0
  return (Number(box.length_mm) || 0) * (Number(box.width_mm) || 0) * (Number(box.height_mm) || 0)
}

/** Containers an order of `quantity` needs at `unitsPerContainer` each; 0
 *  when nothing fits. */
export function containersNeeded(quantity, unitsPerContainer) {
  return unitsPerContainer > 0 ? Math.ceil(quantity / unitsPerContainer) : 0
}

/** Units loaded into container `index` (0-based). */
export function unitsInContainer(index, quantity, unitsPerContainer) {
  if (!(unitsPerContainer > 0)) return 0
  return Math.max(0, Math.min(unitsPerContainer, quantity - index * unitsPerContainer))
}

/** Volume fill (%) of ONE container holding `unitCount` tanks. */
export function volumeUtilization(unitCount, tankVolume, containerVolume) {
  return containerVolume ? ((unitCount * tankVolume) / containerVolume) * 100 : 0
}

/**
 * The full per-container split for one item.
 *
 * @param {object} args
 * @param {number} args.quantity           order qty, already normalized (> 0)
 * @param {number} args.unitsPerContainer  from the fit plan, else the layout
 * @param {object} args.tank               `{ length_mm, width_mm, height_mm }`
 * @param {object} args.container          same shape, internal dimensions
 * @param {number} [args.unitWeightKg]     one tank's weight, for per-row kg
 * @returns {{ quantity, unitsPerContainer, containers, rows, totalWeightKg, shipmentUtilization }}
 *   `rows[i]` = `{ index, loaded, free, weightKg, utilization }`;
 *   `shipmentUtilization` = fill across ALL containers needed (the figure the
 *   wizard labels "Utilization (this order)" and the 3D dialog "Shipment
 *   utilization").
 */
export function containerBreakdown({ quantity, unitsPerContainer, tank, container, unitWeightKg = 0 }) {
  const qty = Math.max(0, Number(quantity) || 0)
  const units = Math.max(0, Number(unitsPerContainer) || 0)
  const weight = Number(unitWeightKg) || 0
  const tankVolume = boxVolume(tank)
  const containerVolume = boxVolume(container)
  const containers = containersNeeded(qty, units)
  const rows = Array.from({ length: containers }, (_, index) => {
    const loaded = unitsInContainer(index, qty, units)
    return {
      index,
      loaded,
      free: units - loaded,
      weightKg: loaded * weight,
      utilization: volumeUtilization(loaded, tankVolume, containerVolume)
    }
  })
  return {
    quantity: qty,
    unitsPerContainer: units,
    containers,
    rows,
    totalWeightKg: qty * weight,
    shipmentUtilization: containers ? volumeUtilization(qty, tankVolume, containerVolume) / containers : 0
  }
}

/** A worksheet's `container_overrides` child rows (DocType "Container Load
 *  Override") as the plain `{ container_no, standard_gap_mm,
 *  pallet_thickness_mm }` list `preview_container_fit` takes -- no child-doc
 *  bookkeeping keys, rows without a valid container number dropped. Always an
 *  array (possibly empty), so unsaved deletions win over the saved rows. */
export function containerOverridesPayload(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      container_no: Math.trunc(Number(row?.container_no) || 0),
      standard_gap_mm: numberOrNull(row?.standard_gap_mm),
      pallet_thickness_mm: numberOrNull(row?.pallet_thickness_mm)
    }))
    .filter((row) => row.container_no >= 1)
}

/** A Float field's value as a backend-optional number: blank / missing /
 *  non-numeric → null (the backend then falls back to its own default, e.g.
 *  Packing Settings), anything else → Number. Keeps a cleared input from
 *  being sent as `""`, which whitelist type enforcement would reject, or as
 *  0, which is a real (different) value for a gap or pallet thickness. */
export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

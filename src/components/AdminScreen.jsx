import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import Icon from "./ui/Icon.jsx";
import { Section, Badge, useUI, timeAgo, formatDateTime } from "./ui/ui.jsx";
import Labels from "./Labels.jsx";

// Owner-only settings. Every action is re-checked on the server
// (_require_owner); hiding these sections from staff is only convenience.

export function CompanySettings({
  orgId,
  orgName,
  overdueDays = 3,
  scanReturns = true,
  onRenamed,
}) {
  const ui = useUI();
  const [name, setName] = useState(orgName);
  const [days, setDays] = useState(String(overdueDays));
  const [returns, setReturns] = useState(scanReturns);
  const [saving, setSaving] = useState(false);
  const daysOk = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 60;
  const dirty =
    name.trim() &&
    daysOk &&
    (name.trim() !== orgName ||
      Number(days) !== overdueDays ||
      returns !== scanReturns);

  async function rename(e) {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase
      .from("orgs")
      .update({
        name: name.trim(),
        overdue_days: Number(days),
        scan_returns: returns,
      })
      .eq("id", orgId);
    setSaving(false);
    if (error) return ui.toast(error.message, "error");
    ui.toast("Company settings saved.", "ok");
    onRenamed();
  }

  return (
    <Section
      title="Company"
      description="Shown in the app header and on every device."
    >
      <form onSubmit={rename} className="stack" style={{ gap: 14 }}>
        <label>
          Company name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={returns}
            onChange={(e) => setReturns(e.target.checked)}
            data-testid="scan-returns"
          />
          <span>
            <b>We scan items when they come back</b> (Check IN)
            <span className="hint" style={{ display: "block" }}>
              Off: items are scanned only when loading and in the stocktake.
              Loading an item that’s still “out” counts as a new load, and the
              stocktake shows what is <i>missing</i> and what is <i>not back</i>
              .
            </span>
          </span>
        </label>
        {returns && (
          <label>
            Overdue after (days)
            <input
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              style={{ maxWidth: 120 }}
              data-testid="overdue-days"
            />
            <span className="hint">
              Units out longer than this are listed as overdue on the Overview.
            </span>
          </label>
        )}
        <div className="row end">
          <button className="primary" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Section>
  );
}

export function AccessSettings({ orgId }) {
  const ui = useUI();
  const [status, setStatus] = useState(null);
  const [devices, setDevices] = useState(null);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [kick, setKick] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([
      supabase.rpc("pin_status", { p_org: orgId }),
      supabase.rpc("list_devices", { p_org: orgId }),
    ]);
    if (s.error || d.error)
      return ui.toast((s.error || d.error).message, "error");
    setStatus(s.data);
    setDevices(d.data);
  }, [orgId, ui]);

  useEffect(() => {
    load();
  }, [load]);

  async function savePin(e) {
    e.preventDefault();
    if (pin !== pin2) return ui.toast("The two PINs don’t match.", "error");
    if (kick) {
      const ok = await ui.confirm({
        title: "Sign out every PIN device?",
        body: "Staff will need the new PIN on each device. Use this when someone leaves the company.",
        confirmLabel: "Change PIN and sign out devices",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("set_pin", {
      p_org: orgId,
      p_pin: pin,
      p_remove_devices: kick,
    });
    setBusy(false);
    if (error) return ui.toast(error.message, "error");
    setPin("");
    setPin2("");
    setKick(false);
    ui.toast(
      `PIN saved.${data.removed_devices ? ` ${data.removed_devices} device(s) signed out.` : ""}`,
      "ok",
    );
    load();
  }

  async function remove(d) {
    const ok = await ui.confirm({
      title: `Remove “${d.name}”?`,
      body: "That device is signed out and will need the company PIN to get back in. The PIN itself keeps working until you change it.",
      confirmLabel: "Remove device",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("remove_device", {
      p_org: orgId,
      p_user: d.user_id,
    });
    if (error) return ui.toast(error.message, "error");
    ui.toast(`${d.name} removed.`, "ok");
    load();
  }

  return (
    <>
      <Section
        title="Company PIN"
        description={
          status === null
            ? "Loading…"
            : status.has_pin
              ? `Staff sign in with this PIN · last changed ${formatDateTime(status.updated_at)}`
              : "No PIN yet — staff can’t sign in until you set one."
        }
        actions={
          status &&
          (status.has_pin ? (
            <Badge tone="ok">Active</Badge>
          ) : (
            <Badge tone="warn">Not set</Badge>
          ))
        }
      >
        <form onSubmit={savePin} className="stack" style={{ gap: 14 }}>
          <div className="form-row">
            <label>
              New PIN
              <input
                className="pin-input"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="[0-9]{6,12}"
                title="6 to 12 digits"
                required
                maxLength={12}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
              <span className="hint">
                6–12 digits. Avoid obvious ones (123456, birthdays).
              </span>
            </label>
            <label>
              Repeat PIN
              <input
                className="pin-input"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                required
                maxLength={12}
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={kick}
              onChange={(e) => setKick(e.target.checked)}
            />
            <span>
              Also sign out every PIN device
              <span className="hint" style={{ display: "block" }}>
                Use this when someone leaves the company.
              </span>
            </span>
          </label>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="hint">
              <Icon name="shield" size={13} /> 5 wrong tries block a device for
              15 minutes.
            </span>
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : status?.has_pin ? "Change PIN" : "Set PIN"}
            </button>
          </div>
        </form>
      </Section>

      <Section
        flush
        title="Devices"
        description="Everyone who signed in. Removing a device signs it out."
      >
        {devices === null ? (
          <p className="muted" style={{ padding: 20 }}>
            Loading…
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-sm">Type</th>
                  <th className="hide-sm">Last active</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.user_id}>
                    <td className="primary-cell">
                      {d.name}
                      {d.role === "owner" && (
                        <span className="show-sm">
                          <Badge tone="accent">Owner</Badge>
                        </span>
                      )}
                      {d.email && d.email !== d.name && (
                        <div className="muted small">{d.email}</div>
                      )}
                    </td>
                    <td className="hide-sm">
                      {d.role === "owner" ? (
                        <Badge tone="accent">Owner</Badge>
                      ) : (
                        <span className="muted">PIN device</span>
                      )}
                    </td>
                    <td
                      className="muted small hide-sm"
                      title={d.last_seen_at || d.joined_at}
                    >
                      {timeAgo(d.last_seen_at || d.joined_at)}
                    </td>
                    <td className="num">
                      {d.role === "member" && (
                        <button
                          className="link danger-text"
                          onClick={() => remove(d)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

// Vehicles: owner adds them, prints each one's label (VEH-NN) and can
// deactivate one. Never deleted, so history keeps the name.
export function VehicleSettings({ engine, orgId }) {
  const ui = useUI();
  const [vehicles, setVehicles] = useState(null);
  const [name, setName] = useState("");
  const [plate, setPlate] = useState("");
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(null);

  const load = useCallback(async () => {
    try {
      setVehicles(await engine.pullVehicles(orgId));
    } catch (e) {
      setVehicles(await engine.listVehicles(orgId));
      if (!e.retryable) ui.toast(e.message, "error");
    }
  }, [engine, orgId, ui]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e) {
    e.preventDefault();
    setSaving(true);
    const { data, error } = await supabase
      .from("vehicles")
      .insert({ org_id: orgId, name: name.trim(), plate: plate.trim() || null })
      .select("id, code, name")
      .single();
    setSaving(false);
    if (error)
      return ui.toast(
        error.code === "23505"
          ? "A vehicle with that name already exists."
          : error.message,
        "error",
      );
    ui.toast(
      `${data.name} added as ${data.code}. Print its label and stick it inside the van.`,
      "ok",
    );
    setName("");
    setPlate("");
    load();
  }

  async function setActive(v, active) {
    if (!active) {
      const ok = await ui.confirm({
        title: `Deactivate ${v.name}?`,
        body: "It disappears from the check-out screen. Its history stays, and you can reactivate it later.",
        confirmLabel: "Deactivate",
      });
      if (!ok) return;
    }
    const { error } = await supabase
      .from("vehicles")
      .update({ active })
      .eq("id", v.id);
    if (error) return ui.toast(error.message, "error");
    load();
  }

  if (printing) {
    return (
      <Labels
        units={printing.map((v) => ({
          code: v.code,
          product: `${v.name}${v.plate ? ` · ${v.plate}` : ""}`,
        }))}
        onClose={() => setPrinting(null)}
        backLabel="Back to vehicles"
      />
    );
  }

  const active = (vehicles ?? []).filter((v) => v.active);
  return (
    <>
      <Section
        title="Add a vehicle"
        description="Each vehicle gets a label (VEH-01, VEH-02…). Scan it on Check out / in to load or unload that vehicle."
      >
        <form onSubmit={add} className="stack" style={{ gap: 14 }}>
          <div className="form-row">
            <label>
              Name
              <input
                required
                maxLength={40}
                placeholder="e.g. Van 2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Plate <span className="hint">optional</span>
              <input
                maxLength={12}
                placeholder="e.g. ABC123"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
              />
            </label>
          </div>
          <div className="row end">
            <button className="primary" disabled={saving || !name.trim()}>
              <Icon name="plus" /> {saving ? "Adding…" : "Add vehicle"}
            </button>
          </div>
        </form>
      </Section>

      <Section
        flush
        title="Vehicles"
        actions={
          active.length > 0 && (
            <button
              className="secondary btn-sm"
              onClick={() => setPrinting(active)}
            >
              <Icon name="printer" size={16} /> Print all labels
            </button>
          )
        }
      >
        {vehicles === null ? (
          <p className="muted" style={{ padding: 20 }}>
            Loading…
          </p>
        ) : vehicles.length === 0 ? (
          <p className="muted small" style={{ padding: 20 }}>
            No vehicles yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Label</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id} className={v.active ? "" : "late-row"}>
                    <td className="primary-cell">
                      {v.name}
                      {v.plate && (
                        <div className="muted small mono">{v.plate}</div>
                      )}
                      {!v.active && (
                        <span className="show-sm">
                          <Badge>Inactive</Badge>
                        </span>
                      )}
                    </td>
                    <td>
                      <code>{v.code}</code>{" "}
                      {!v.active && (
                        <span className="hide-sm">
                          <Badge>Inactive</Badge>
                        </span>
                      )}
                    </td>
                    <td className="num">
                      <div
                        className="row"
                        style={{ justifyContent: "flex-end", gap: 14 }}
                      >
                        {v.active && (
                          <button
                            className="link"
                            onClick={() => setPrinting([v])}
                          >
                            Print label
                          </button>
                        )}
                        <button
                          className={`link ${v.active ? "danger-text" : ""}`}
                          onClick={() => setActive(v, !v.active)}
                        >
                          {v.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

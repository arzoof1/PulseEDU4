import { useCallback, useEffect, useState } from "react";
import {
  studentFetch,
  type StudentStore,
  type StoreCatalogItem,
} from "./api";

function statusLabel(status: string): { text: string; cls: string } {
  switch (status) {
    case "pending_approval":
      return {
        text: "Waiting for approval",
        cls: "bg-amber-100 text-amber-700",
      };
    case "pending":
      return { text: "Being prepared", cls: "bg-sky-100 text-sky-700" };
    case "fulfilled":
      return { text: "Picked up", cls: "bg-emerald-100 text-emerald-700" };
    case "cancelled":
      return { text: "Cancelled", cls: "bg-slate-100 text-slate-500" };
    default:
      return { text: status, cls: "bg-slate-100 text-slate-600" };
  }
}

export default function StoreTab() {
  const [store, setStore] = useState<StudentStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<StoreCatalogItem | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await studentFetch("/api/student/store");
      if (!res.ok) {
        setError("Could not load the store.");
        return;
      }
      setStore((await res.json()) as StudentStore);
      setError(null);
    } catch {
      setError("Could not load the store.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function redeem(item: StoreCatalogItem) {
    setRedeeming(true);
    setError(null);
    try {
      const res = await studentFetch("/api/student/store/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setError(body?.error ?? "Could not redeem this reward.");
        return;
      }
      setFlash(
        item.requiresApproval
          ? `Requested "${item.name}" — your teacher will approve it soon!`
          : `You redeemed "${item.name}"! 🎉`,
      );
      setConfirming(null);
      await load();
    } catch {
      setError("Could not redeem this reward.");
    } finally {
      setRedeeming(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-slate-400 text-sm">Loading store…</div>;
  }

  if (store && !store.enabled) {
    return (
      <div className="p-6 text-center text-slate-500">
        The School Store isn't available right now.
      </div>
    );
  }

  if (!store) {
    return (
      <div className="p-6 text-center text-rose-600">
        {error ?? "Could not load the store."}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Wallet */}
      <div className="rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white p-5 shadow-lg">
        <div className="text-sm opacity-80">Available to spend</div>
        <div className="text-4xl font-extrabold">{store.wallet.available}</div>
        <div className="text-xs opacity-75 mt-1">
          {store.wallet.earned} earned all-time · {store.wallet.spent} spent
        </div>
      </div>

      {flash && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-4 py-3">
          {flash}
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {/* Catalog */}
      <div>
        <h2 className="text-lg font-bold text-slate-800 mb-3">Rewards</h2>
        {store.items.length === 0 ? (
          <p className="text-sm text-slate-400">No rewards available yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {store.items.map((item) => {
              const blocked = !item.available || !item.affordable;
              return (
                <div
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 flex gap-3"
                >
                  {item.hasImage && (
                    <img
                      src={`/api/student/store/item/${item.id}/image`}
                      alt=""
                      className="w-16 h-16 rounded-xl object-cover bg-slate-100 flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-800">
                      {item.name}
                    </div>
                    {item.description && (
                      <div className="text-xs text-slate-500 line-clamp-2">
                        {item.description}
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-sm font-bold text-violet-700">
                        {item.pointsCost} pts
                      </span>
                      <button
                        onClick={() => setConfirming(item)}
                        disabled={blocked}
                        className="rounded-lg bg-violet-600 hover:bg-violet-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold px-3 py-1.5 transition"
                      >
                        {item.available
                          ? item.affordable
                            ? item.requiresApproval
                              ? "Request"
                              : "Redeem"
                            : `Need ${item.pointsToGo} more`
                          : (item.unavailableReason ?? "Unavailable")}
                      </button>
                    </div>
                    {item.perStudentLimit !== null && (
                      <div className="text-[11px] text-slate-400 mt-1">
                        {item.ownedActiveCount}/{item.perStudentLimit} redeemed
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Orders */}
      <div>
        <h2 className="text-lg font-bold text-slate-800 mb-3">My orders</h2>
        {store.orders.length === 0 ? (
          <p className="text-sm text-slate-400">No orders yet.</p>
        ) : (
          <div className="space-y-2">
            {store.orders.map((o) => {
              const s = statusLabel(o.status);
              return (
                <div
                  key={o.id}
                  className="rounded-xl border border-slate-200 bg-white p-3 flex items-center justify-between"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 truncate">
                      {o.itemName}
                    </div>
                    <div className="text-xs text-slate-400">
                      {o.pointsSpent} pts
                      {o.deliverTeacherName
                        ? ` · ${o.deliverTeacherName}${o.deliverPeriod ? ` (${o.deliverPeriod})` : ""}`
                        : ""}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.cls}`}
                  >
                    {s.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm modal */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800">
              {confirming.requiresApproval ? "Request" : "Redeem"} this reward?
            </h3>
            <p className="text-sm text-slate-600 mt-2">
              <span className="font-semibold">{confirming.name}</span> for{" "}
              <span className="font-semibold">{confirming.pointsCost} pts</span>.
              {confirming.requiresApproval
                ? " Your teacher will need to approve it."
                : " This will use your points right away."}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirming(null)}
                disabled={redeeming}
                className="flex-1 rounded-xl border border-slate-200 text-slate-600 font-semibold py-2.5 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => redeem(confirming)}
                disabled={redeeming}
                className="flex-1 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-semibold py-2.5 disabled:opacity-50"
              >
                {redeeming ? "…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

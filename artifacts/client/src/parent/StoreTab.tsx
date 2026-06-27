import { useEffect, useState } from "react";
import { Gift, Sparkles, Lock, CheckCircle2, Loader2, Truck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { parentFetch } from "./api";

export interface StoreWallet {
  earned: number;
  spent: number;
  available: number;
}

export interface StoreItem {
  id: number;
  name: string;
  description: string;
  pointsCost: number;
  hasImage: boolean;
  requiresApproval: boolean;
  perStudentLimit: number | null;
  ownedActiveCount: number;
  available: boolean;
  unavailableReason: string | null;
  affordable: boolean;
  pointsToGo: number;
}

export interface StoreOrder {
  id: number;
  itemName: string;
  pointsSpent: number;
  status: string;
  createdAt: string;
  fulfilledAt: string | null;
  deliverTeacherName: string | null;
  deliverPeriod: string | null;
  cancelReason: string | null;
}

export interface StoreData {
  enabled: boolean;
  wallet: StoreWallet;
  items: StoreItem[];
  orders: StoreOrder[];
}

// Thumbnail loaded through the parent-authed proxy. The session cookie is
// blocked inside the Replit preview iframe, so a plain <img src> would 401 —
// we fetch the bytes with parentFetch (which attaches the Bearer token) and
// render them from an object URL, mirroring the staff StudentPhoto pattern.
function ItemThumb({
  itemId,
  studentId,
  name,
}: {
  itemId: number;
  studentId: number;
  name: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const res = await parentFetch(
          `/api/parent/store/item/${itemId}/image?studentId=${studentId}`,
        );
        if (cancelled || !res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setSrc(url);
        else URL.revokeObjectURL(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [itemId, studentId]);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className="h-16 w-16 rounded-xl object-cover bg-slate-100 shrink-0"
      />
    );
  }
  return (
    <div
      className={
        "h-16 w-16 rounded-xl flex items-center justify-center shrink-0 " +
        (failed ? "bg-slate-100" : "bg-gradient-to-br from-violet-100 to-teal-100")
      }
    >
      <Gift className="h-7 w-7 text-violet-400" />
    </div>
  );
}

function StatusBadge({ order }: { order: StoreOrder }) {
  // Map the engine's redemption lifecycle into family-friendly copy. Once an
  // item is fulfilled we tell the family exactly where to pick it up.
  if (order.status === "fulfilled") {
    const where =
      order.deliverTeacherName && order.deliverPeriod
        ? `Delivered in ${order.deliverTeacherName}'s ${order.deliverPeriod}`
        : order.deliverTeacherName
          ? `Delivered to ${order.deliverTeacherName}`
          : "Delivered";
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {where}
      </span>
    );
  }
  if (order.status === "pending_approval") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
        <Loader2 className="h-3.5 w-3.5" />
        Waiting for staff approval
      </span>
    );
  }
  if (order.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700">
        <Truck className="h-3.5 w-3.5" />
        On the way
      </span>
    );
  }
  // cancelled / refunded
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
      Cancelled
      {order.cancelReason ? ` — ${order.cancelReason}` : ""}
    </span>
  );
}

export default function StoreTab({
  studentId,
  studentFirstName,
  data,
  loading,
  error,
  onRedeemed,
}: {
  studentId: number;
  studentFirstName: string;
  data: StoreData | null;
  loading: boolean;
  error: string;
  onRedeemed: () => void;
}) {
  // The item the family tapped "Redeem" on — drives the inline confirm step
  // (window.confirm is suppressed inside the preview iframe, so we confirm
  // with a two-tap inline panel instead).
  const [confirmItem, setConfirmItem] = useState<StoreItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redeemError, setRedeemError] = useState("");
  const [justRedeemed, setJustRedeemed] = useState<string | null>(null);

  // Sibling switch / data reload clears any in-flight confirm so we never
  // redeem against a stale student or item.
  useEffect(() => {
    setConfirmItem(null);
    setRedeemError("");
    setJustRedeemed(null);
  }, [studentId]);

  async function doRedeem(item: StoreItem) {
    if (submitting) return;
    setSubmitting(true);
    setRedeemError("");
    try {
      const res = await parentFetch("/api/parent/store/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, itemId: item.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRedeemError(body.error ?? `Could not redeem (${res.status})`);
        return;
      }
      setConfirmItem(null);
      setJustRedeemed(
        item.requiresApproval
          ? `Request sent! A staff member will approve ${item.name} soon.`
          : `Success! ${item.name} is on the way.`,
      );
      onRedeemed();
    } catch (e) {
      setRedeemError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="text-sm text-slate-500 text-center py-12">Loading…</div>
    );
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { wallet, items, orders } = data;

  return (
    <div className="space-y-5 pb-4">
      {/* Wallet — available-to-spend is the hero; lifetime earned is context. */}
      <Card className="overflow-hidden border-0 shadow-sm">
        <div className="bg-gradient-to-br from-violet-600 to-teal-600 text-white p-5">
          <div className="flex items-center gap-2 text-white/80 text-xs font-semibold uppercase tracking-wide">
            <Sparkles className="h-4 w-4" />
            {studentFirstName}'s points
          </div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-4xl font-extrabold leading-none">
              {wallet.available.toLocaleString()}
            </span>
            <span className="text-sm font-medium text-white/80 mb-0.5">
              available to spend
            </span>
          </div>
          <div className="mt-1 text-xs text-white/70">
            {wallet.earned.toLocaleString()} earned all-time ·{" "}
            {wallet.spent.toLocaleString()} spent
          </div>
        </div>
      </Card>

      {justRedeemed && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded-xl p-3 text-sm flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{justRedeemed}</span>
        </div>
      )}

      {/* Catalog */}
      <div>
        <h2 className="text-sm font-bold text-slate-700 mb-2 px-1">
          School Store
        </h2>
        {items.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-slate-500">
              The school store is empty right now. Check back soon!
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => {
              const canRedeem =
                item.available && item.affordable && wallet.available > 0;
              const isConfirming = confirmItem?.id === item.id;
              return (
                <Card key={item.id} className="overflow-hidden">
                  <CardContent className="p-3">
                    <div className="flex items-start gap-3">
                      {item.hasImage ? (
                        <ItemThumb
                          itemId={item.id}
                          studentId={studentId}
                          name={item.name}
                        />
                      ) : (
                        <div className="h-16 w-16 rounded-xl flex items-center justify-center shrink-0 bg-gradient-to-br from-violet-100 to-teal-100">
                          <Gift className="h-7 w-7 text-violet-400" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-900 leading-tight">
                          {item.name}
                        </div>
                        {item.description && (
                          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                            {item.description}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-sm font-bold text-violet-700">
                            <Sparkles className="h-3.5 w-3.5" />
                            {item.pointsCost.toLocaleString()} pts
                          </span>
                          {!item.available && item.unavailableReason ? (
                            <span className="text-xs font-semibold text-slate-400">
                              {item.unavailableReason}
                            </span>
                          ) : item.affordable ? (
                            <span className="text-xs font-semibold text-green-600">
                              Affordable now
                            </span>
                          ) : (
                            <span className="text-xs font-semibold text-amber-600">
                              {item.pointsToGo.toLocaleString()} points to go
                            </span>
                          )}
                          {item.requiresApproval && item.available && (
                            <span className="text-[11px] text-slate-400">
                              Needs approval
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action row — inline two-tap confirm. */}
                    <div className="mt-3">
                      {isConfirming ? (
                        <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
                          <div className="text-xs text-slate-600 mb-2">
                            Spend{" "}
                            <strong>{item.pointsCost.toLocaleString()}</strong>{" "}
                            of {studentFirstName}'s points on{" "}
                            <strong>{item.name}</strong>?
                          </div>
                          {redeemError && (
                            <div className="text-xs text-red-600 mb-2">
                              {redeemError}
                            </div>
                          )}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="flex-1"
                              disabled={submitting}
                              onClick={() => doRedeem(item)}
                            >
                              {submitting ? "Redeeming…" : "Confirm"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={submitting}
                              onClick={() => {
                                setConfirmItem(null);
                                setRedeemError("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          className="w-full"
                          variant={canRedeem ? "default" : "outline"}
                          disabled={!canRedeem}
                          onClick={() => {
                            setRedeemError("");
                            setConfirmItem(item);
                          }}
                        >
                          {!item.available ? (
                            <>
                              <Lock className="h-3.5 w-3.5 mr-1" />
                              {item.unavailableReason ?? "Unavailable"}
                            </>
                          ) : !item.affordable ? (
                            <>Not enough points</>
                          ) : (
                            <>Redeem</>
                          )}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Order history */}
      {orders.length > 0 && (
        <div>
          <h2 className="text-sm font-bold text-slate-700 mb-2 px-1">
            {studentFirstName}'s orders
          </h2>
          <div className="space-y-2">
            {orders.map((o) => (
              <Card key={o.id}>
                <CardContent className="p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {o.itemName}
                    </div>
                    <div className="mt-0.5">
                      <StatusBadge order={o} />
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-slate-500 shrink-0">
                    {o.pointsSpent.toLocaleString()} pts
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

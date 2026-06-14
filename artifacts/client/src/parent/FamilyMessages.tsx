// Parent-portal "Family Messages" inbox. Family-scoped (NOT per-student), so
// it lives at the top of the dashboard above the student switcher's content
// and fetches once per parent. Each message can be acknowledged ("Got it"),
// which the school sees as a real counter. A "Power Reader" badge surfaces for
// families who consistently acknowledge — purely derived, no PBIS points.
import { useEffect, useRef, useState } from "react";
import {
  Mail,
  MailOpen,
  CheckCircle2,
  Star,
  Paperclip,
  Download,
  Eye,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parentFetch } from "./api";

interface ParentMessage {
  id: number;
  subject: string;
  body: string;
  hasAttachment: boolean;
  attachmentName: string | null;
  attachmentType: string | null;
  senderName: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

interface InboxResponse {
  powerReader: boolean;
  unreadCount: number;
  messages: ParentMessage[];
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function FamilyMessages() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acking, setAcking] = useState<number | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  // Inline attachment preview: per-message object URL + open/closed state.
  // We keep the bytes in-document (no new tab) so the staff "preview as
  // parent" path inside the Replit iframe — where blob tabs render blank —
  // still works, and so phones never force a download just to peek.
  const [attach, setAttach] = useState<
    Record<number, { url: string; open: boolean }>
  >({});
  const [viewing, setViewing] = useState<number | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  // Revoke every object URL we created when the inbox unmounts.
  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];
    };
  }, []);

  async function load() {
    try {
      const res = await parentFetch("/api/parent/messages");
      if (!res.ok) {
        setError(`Could not load messages (${res.status})`);
        return;
      }
      const body = (await res.json()) as InboxResponse;
      setData(body);
      setError("");
    } catch {
      setError("Could not load messages");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await parentFetch("/api/parent/messages");
        if (cancelled) return;
        if (!res.ok) {
          setError(`Could not load messages (${res.status})`);
          return;
        }
        const body = (await res.json()) as InboxResponse;
        if (cancelled) return;
        setData(body);
        setError("");
      } catch {
        if (!cancelled) setError("Could not load messages");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function acknowledge(id: number) {
    if (acking != null) return;
    setAcking(id);
    try {
      const res = await parentFetch(`/api/parent/messages/${id}/ack`, {
        method: "POST",
      });
      if (res.ok) await load();
    } catch {
      /* swallow — leave the button for a retry */
    } finally {
      setAcking(null);
    }
  }

  // Inline view: fetch the authed bytes once (parentFetch carries the Bearer
  // token), turn them into an object URL, and reveal them in-document — an
  // <img> for PNGs, an <object> for PDFs. Subsequent taps just toggle the
  // already-loaded preview open/closed. No new tab, no forced download.
  async function viewAttachment(m: ParentMessage) {
    const existing = attach[m.id];
    if (existing) {
      setAttach((s) => ({
        ...s,
        [m.id]: { ...existing, open: !existing.open },
      }));
      return;
    }
    if (viewing != null) return;
    setViewing(m.id);
    try {
      const res = await parentFetch(`/api/parent/messages/${m.id}/attachment`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.push(url);
      setAttach((s) => ({ ...s, [m.id]: { url, open: true } }));
    } catch {
      /* swallow — the Save fallback still works */
    } finally {
      setViewing(null);
    }
  }

  // Save fallback: synthesize an <a download> click. Kept for the rare mobile
  // browser that won't render a blob PDF inline, and for parents who want the
  // file on disk. parentFetch attaches the Bearer token for the authed read.
  async function downloadAttachment(m: ParentMessage) {
    if (downloading != null) return;
    setDownloading(m.id);
    try {
      const res = await parentFetch(`/api/parent/messages/${m.id}/attachment`);
      if (!res.ok) return;
      const blob = await res.blob();
      const ext = m.attachmentType === "application/pdf" ? "pdf" : "png";
      const filename = m.attachmentName || `attachment.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      /* swallow */
    } finally {
      setDownloading(null);
    }
  }

  // Render nothing until we know there's something to show. A family with no
  // messages should not see an empty card cluttering the dashboard.
  if (loading) return null;
  if (error) {
    return (
      <Card className="border-slate-100">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="h-4 w-4 text-teal-600" />
            <h2 className="text-base font-semibold text-slate-800">
              Messages from school
            </h2>
          </div>
          <p className="text-sm text-rose-600">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!data || data.messages.length === 0) return null;

  return (
    <Card className="border-slate-100">
      <CardContent className="p-6">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-teal-600" />
            <h2 className="text-base font-semibold text-slate-800">
              Messages from school
            </h2>
            {data.unreadCount > 0 && (
              <Badge
                variant="secondary"
                className="bg-rose-100 text-rose-700 hover:bg-rose-100 tabular-nums"
              >
                {data.unreadCount} new
              </Badge>
            )}
          </div>
          {data.powerReader && (
            <Badge
              variant="secondary"
              className="bg-amber-100 text-amber-700 hover:bg-amber-100 gap-1"
              title="You consistently read and acknowledge school messages. Thank you!"
            >
              <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500" />
              Power Reader
            </Badge>
          )}
        </div>

        <div className="space-y-3">
          {data.messages.map((m) => {
            const acked = m.acknowledgedAt != null;
            return (
              <div
                key={m.id}
                className={
                  "rounded-xl border p-4 " +
                  (acked
                    ? "border-slate-100 bg-white"
                    : "border-teal-200 bg-teal-50/40")
                }
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-2 min-w-0">
                    {acked ? (
                      <MailOpen className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                    ) : (
                      <Mail className="h-4 w-4 text-teal-600 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {m.subject}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {m.senderName} · {formatWhen(m.createdAt)}
                      </p>
                    </div>
                  </div>
                  {acked && (
                    <Badge
                      variant="secondary"
                      className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 gap-1 shrink-0"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Got it
                    </Badge>
                  )}
                </div>

                <p className="text-sm text-slate-700 whitespace-pre-wrap mt-3">
                  {m.body}
                </p>

                {m.hasAttachment && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        disabled={viewing === m.id}
                        onClick={() => viewAttachment(m)}
                      >
                        <Paperclip className="h-4 w-4" />
                        <span className="truncate max-w-[200px]">
                          {viewing === m.id
                            ? "Opening…"
                            : m.attachmentName || "Attachment"}
                        </span>
                        {attach[m.id]?.open ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-slate-500"
                        disabled={downloading === m.id}
                        onClick={() => downloadAttachment(m)}
                      >
                        <Download className="h-4 w-4" />
                        {downloading === m.id ? "Saving…" : "Save"}
                      </Button>
                    </div>

                    {attach[m.id]?.open && (
                      <div className="rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
                        {m.attachmentType === "application/pdf" ? (
                          <object
                            data={attach[m.id].url}
                            type="application/pdf"
                            className="w-full"
                            style={{ height: 480 }}
                            aria-label={m.attachmentName || "PDF attachment"}
                          >
                            <div className="p-4 text-sm text-slate-600">
                              Can&apos;t preview this here.{" "}
                              <button
                                type="button"
                                className="underline text-teal-700"
                                onClick={() => downloadAttachment(m)}
                              >
                                Tap to download
                              </button>
                              .
                            </div>
                          </object>
                        ) : (
                          <img
                            src={attach[m.id].url}
                            alt={m.attachmentName || "Attachment"}
                            className="w-full h-auto block"
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {!acked && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      className="gap-2 bg-teal-600 hover:bg-teal-700"
                      disabled={acking === m.id}
                      onClick={() => acknowledge(m.id)}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {acking === m.id ? "Saving…" : "Got it"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

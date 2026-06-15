export default function OpsTicketing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        08 · School Operations
      </div>

      <div className="mt-[8vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
          Event Ticketing
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3.4vw] font-bold leading-[1.04] tracking-[-0.03em]">
          One QR from invite to entry
        </h1>
        <p className="mt-[1.2vh] max-w-[64vw] font-body text-[2vw] leading-[1.3] text-[#5B6B79]">
          Free-ticket events with per-grade quotas — every student gets a QR ticket by email, scanned at the door without a login.
        </p>
      </div>

      <div className="mt-[5vh] flex items-stretch gap-[1vw]">
        <div className="flex-1 rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.6vw] py-[2.6vh]">
          <div className="font-display text-[2vw] font-bold text-[#F2A33C]">1</div>
          <div className="mt-[1vh] font-display text-[2vw] font-bold">Create</div>
          <p className="mt-[1vh] font-body text-[1.5vw] leading-[1.25] text-[#5B6B79]">Set the event and per-grade quotas.</p>
        </div>
        <div className="flex items-center font-display text-[2vw] text-[#15B8A6]">→</div>
        <div className="flex-1 rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.6vw] py-[2.6vh]">
          <div className="font-display text-[2vw] font-bold text-[#F2A33C]">2</div>
          <div className="mt-[1vh] font-display text-[2vw] font-bold">Deliver</div>
          <p className="mt-[1vh] font-body text-[1.5vw] leading-[1.25] text-[#5B6B79]">QR tickets emailed per student.</p>
        </div>
        <div className="flex items-center font-display text-[2vw] text-[#15B8A6]">→</div>
        <div className="flex-1 rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.6vw] py-[2.6vh]">
          <div className="font-display text-[2vw] font-bold text-[#F2A33C]">3</div>
          <div className="mt-[1vh] font-display text-[2vw] font-bold">Scan</div>
          <p className="mt-[1vh] font-body text-[1.5vw] leading-[1.25] text-[#5B6B79]">Volunteers scan — no login needed.</p>
        </div>
        <div className="flex items-center font-display text-[2vw] text-[#15B8A6]">→</div>
        <div className="flex-1 rounded-[0.9vw] bg-[#0B1F33] text-[#EAF2F0] px-[1.6vw] py-[2.6vh]">
          <div className="font-display text-[2vw] font-bold text-[#2DD4BF]">4</div>
          <div className="mt-[1vh] font-display text-[2vw] font-bold">Verify</div>
          <p className="mt-[1vh] font-body text-[1.5vw] leading-[1.25] text-[#C7D6DE]">First scan wins; history is logged.</p>
        </div>
      </div>

      <div className="mt-[5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">Issue a ticket, then scan it — atomic first-scan-wins at the door</span>
      </div>
    </div>
  );
}

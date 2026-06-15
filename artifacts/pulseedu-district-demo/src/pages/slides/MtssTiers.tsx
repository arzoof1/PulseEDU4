export default function MtssTiers() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        04 · MTSS Interventions
      </div>

      <div className="mt-[8vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
          Tiered Intervention System
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3.4vw] font-bold leading-[1.04] tracking-[-0.03em]">
          Two months of documented support
        </h1>
        <p className="mt-[1.2vh] max-w-[64vw] font-body text-[2vw] leading-[1.3] text-[#5B6B79]">
          Not one moment — a real intervention story with multiple entries, multiple staff, and a visible progression.
        </p>
      </div>

      <div className="mt-[4vh] flex h-[50vh] gap-[3vw]">
        <div className="flex-1 rounded-[1vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[2.4vw] py-[3vh] flex flex-col">
          <div className="flex items-baseline gap-[1vw]">
            <span className="font-display text-[2.8vw] font-bold text-[#F2A33C] leading-none">T2</span>
            <span className="font-display text-[2vw] font-bold">Tier 2</span>
          </div>
          <div className="mt-[2.6vh] flex flex-col gap-[2vh]">
            <p className="font-body text-[2vw] leading-[1.25]">Goal set, then weekly progress monitoring across the window.</p>
            <p className="font-body text-[2vw] leading-[1.25]">Strategy categories tie each entry to a named approach.</p>
            <p className="font-body text-[2vw] leading-[1.25]">A timeline shows the full two months at a glance.</p>
          </div>
        </div>

        <div className="flex-1 rounded-[1vw] bg-[#0B1F33] text-[#EAF2F0] px-[2.4vw] py-[3vh] flex flex-col">
          <div className="flex items-baseline gap-[1vw]">
            <span className="font-display text-[2.8vw] font-bold text-[#2DD4BF] leading-none">T3</span>
            <span className="font-display text-[2vw] font-bold">Tier 3</span>
          </div>
          <div className="mt-[2.6vh] flex flex-col gap-[2vh]">
            <p className="font-body text-[2vw] leading-[1.25] text-[#C7D6DE]">Intensive academic support tracked in minutes — met, owed, excused.</p>
            <p className="font-body text-[2vw] leading-[1.25] text-[#C7D6DE]">Check-ins on scheduled meeting days, with bell reminders.</p>
            <p className="font-body text-[2vw] leading-[1.25] text-[#C7D6DE]">A clear progression of supports as the plan deepens.</p>
          </div>
        </div>
      </div>

      <div className="mt-[3.5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">Tier 3 academic plans — Alina Maddox (ELA), Amelia Abbott &amp; Sienna Osborne (math)</span>
      </div>
    </div>
  );
}

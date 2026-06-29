export default function StudentSupportSafetyPlans() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        03 · Student Support
      </div>

      <div className="mt-[8vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
          Safety Plans
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3vw] font-bold leading-[1.1] tracking-[-0.03em] max-w-[72vw] text-balance">
          Every student&apos;s safety plan, in one shared and audited place
        </h1>
      </div>

      <div className="mt-[5vh] grid grid-cols-3 gap-[1.6vw]">
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.8vh]">
          <div className="font-display text-[2vw] font-bold">Built from a library</div>
          <p className="mt-[1.4vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            Behavioral and physical safety checklists assembled from a reusable item library.
          </p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.8vw] py-[2.8vh]">
          <div className="font-display text-[2vw] font-bold">Right people, right access</div>
          <p className="mt-[1.4vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            Counselors and Core Team edit; every staff member can see what to do.
          </p>
        </div>
        <div className="rounded-[0.9vw] bg-[#0B1F33] text-[#EAF2F0] px-[1.8vw] py-[2.8vh]">
          <div className="font-display text-[2vw] font-bold text-[#2DD4BF]">Full audit log</div>
          <p className="mt-[1.4vh] font-body text-[1.6vw] leading-[1.3] text-[#C7D6DE]">
            Every change is recorded — who, what, and when — so the plan is defensible.
          </p>
        </div>
      </div>

      <div className="mt-[5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Why it matters</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">When a moment arrives, the adult in the room already knows the plan — not the filing cabinet.</span>
      </div>
    </div>
  );
}

export default function FastCoverage() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        07 · Leadership Intelligence
      </div>

      <div className="mt-[8vh] flex h-[76vh] gap-[4vw]">
        <div className="w-[44vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            FAST Coverage &amp; School Grade
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.4vw] font-bold leading-[1.05] tracking-[-0.03em]">
            The state report, all year long
          </h1>

          <div className="mt-[3.5vh] flex flex-col gap-[2.4vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                The estimated school grade is computed from the same nine components Florida uses.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                FAST achievement and learning gains update automatically each PM window.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Leaders see where the grade stands today — and what would move it.
              </p>
            </div>
          </div>

          <div className="mt-[4vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
            <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
            <span className="font-body text-[1.5vw] text-[#EAF2F0]">School Grade Calculator across PM1 / PM2 / PM3</span>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="w-full rounded-[1vw] bg-white border border-[#0B1F33]/12 px-[2.6vw] py-[4vh] shadow-[0_2vh_4vh_rgba(11,31,51,0.12)]">
            <div className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#15B8A6]">Estimated school grade</div>
            <div className="mt-[1.5vh] flex items-baseline gap-[1vw]">
              <span className="font-display text-[8vw] font-bold leading-none tracking-[-0.04em] text-[#0B1F33]">B</span>
              <span className="font-display text-[3vw] font-bold text-[#F2A33C]">541 pts</span>
            </div>
            <div className="mt-[3vh] h-[1.4vh] w-full rounded-full bg-[#E7E1D4] overflow-hidden">
              <div className="h-full w-[62%] rounded-full bg-[#15B8A6]" />
            </div>
            <p className="mt-[2.2vh] font-body text-[1.5vw] leading-[1.35] text-[#5B6B79]">
              Nine components × 100 — FAST achievement, learning gains, and lowest-quartile growth, projected in real time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

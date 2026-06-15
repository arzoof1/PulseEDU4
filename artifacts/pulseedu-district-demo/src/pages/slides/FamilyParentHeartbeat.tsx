export default function FamilyParentHeartbeat() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        06 · Family Communication
      </div>

      <div className="mt-[9vh] flex h-[74vh] gap-[4vw]">
        <div className="w-[46vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            Parent Portal · Family HeartBEAT
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.4vw] font-bold leading-[1.05] tracking-[-0.03em]">
            The family&apos;s window into campus
          </h1>

          <div className="mt-[3.5vh] flex flex-col gap-[2.2vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Hall passes, check-ins, and attendance as the school day unfolds.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Tardies and lost instructional minutes, kept honest and visible.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                FAST benchmark scores with the next steps that follow them.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                The interventions and accommodations their child is receiving.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Important school messages — read and acknowledged in one tap.
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="w-full rounded-[1vw] bg-[#0B1F33] text-[#EAF2F0] px-[2.6vw] py-[4vh] shadow-[0_2vh_4vh_rgba(11,31,51,0.16)]">
            <div className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">
              One honest record
            </div>
            <p className="mt-[2vh] font-display text-[2.6vw] font-bold leading-[1.2] tracking-[-0.02em]">
              The same HeartBEAT staff see — shared directly with families.
            </p>
            <p className="mt-[2.5vh] font-body text-[1.5vw] leading-[1.35] text-[#B9C9D3]">
              Secure and per-student, with sibling switching, configurable section visibility, and PDF export.
            </p>

            <div className="mt-[3.5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#15B8A6] px-[1.4vw] py-[1.1vh]">
              <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#06342E]">Live demo</span>
              <span className="font-body text-[1.5vw] font-medium text-[#06342E]">A parent&apos;s view of their own child</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

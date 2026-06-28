export default function LeadershipSchoolGrade() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        07 · Leadership Intelligence
      </div>

      <div className="mt-[9vh] flex h-[74vh] gap-[4vw]">
        <div className="w-[42vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            School Grade Calculator
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.1vw] font-bold leading-[1.07] tracking-[-0.03em]">
            An estimated Florida school grade, every window
          </h1>

          <div className="mt-[4vh] flex flex-col gap-[2.4vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[1.9vw] leading-[1.3]">
                Nine components, each out of 100, modeled the way the state calculates them.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[1.9vw] leading-[1.3]">
                FAST achievement and learning-gains components compute from live data.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[1.9vw] leading-[1.3]">
                Run it at PM1, PM2, and PM3 to see the trajectory before the official grade.
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="grid w-full grid-cols-3 gap-[1vw]">
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">ELA Achievement</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">Math Achievement</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">Science</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">ELA Learning Gains</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">Math Learning Gains</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">Social Studies</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">ELA LG Lowest 25%</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1]">Math LG Lowest 25%</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#5B6B79]">/100</div>
            </div>
            <div className="rounded-[0.7vw] bg-[#0B1F33] text-[#EAF2F0] px-[1.2vw] py-[1.8vh]">
              <div className="font-display text-[1.5vw] font-bold leading-[1.1] text-[#2DD4BF]">MS Acceleration</div>
              <div className="mt-[0.6vh] font-body text-[1.3vw] text-[#C7D6DE]">/100</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TeacherRoster() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        02 · Teacher Experience
      </div>

      <div className="mt-[8vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
          The Teacher Roster
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3.4vw] font-bold leading-[1.04] tracking-[-0.03em]">
          Reducing teacher workload
        </h1>
        <p className="mt-[1.2vh] max-w-[62vw] font-body text-[2vw] leading-[1.3] text-[#5B6B79]">
          One screen replaces the spreadsheets a teacher used to keep by hand — every student, every signal, in context.
        </p>
      </div>

      <div className="mt-[4vh] grid grid-cols-2 gap-x-[4vw] gap-y-[2.4vh]">
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[2vw] py-[2.2vh]">
          <div className="font-display text-[2vw] font-bold">Benchmark data at a glance</div>
          <p className="mt-[0.8vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            FAST scores, levels, and bottom standards — color-coded so needs jump out.
          </p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[2vw] py-[2.2vh]">
          <div className="font-display text-[2vw] font-bold">Flags that matter</div>
          <p className="mt-[0.8vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            ESE, 504, ELL, and safety-plan indicators surface inline — no separate systems.
          </p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[2vw] py-[2.2vh]">
          <div className="font-display text-[2vw] font-bold">Growth, made visible</div>
          <p className="mt-[0.8vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            Learning-gain green-checks credit real movement between FAST windows.
          </p>
        </div>
        <div className="rounded-[0.9vw] bg-[#FBF9F4] border border-[#0B1F33]/10 px-[2vw] py-[2.2vh]">
          <div className="font-display text-[2vw] font-bold">One source of truth</div>
          <p className="mt-[0.8vh] font-body text-[1.6vw] leading-[1.3] text-[#5B6B79]">
            The roster a teacher uses is the one the Core Team sees — same data.
          </p>
        </div>
      </div>

      <div className="mt-[3.5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">Amy Brown — Math, Grade 7 roster with FAST benchmarks</span>
      </div>
    </div>
  );
}

export default function Cover() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0B1F33] text-[#EAF2F0] font-body px-[6vw] py-[6vh]">
      <div className="absolute inset-0 bg-[radial-gradient(120%_95%_at_88%_12%,#16314a_0%,#0B1F33_55%)]" />

      <div className="absolute top-[5vh] left-[6vw] z-10 flex items-center gap-[0.8vw]">
        <div className="h-[1.7vw] w-[1.7vw] rounded-[0.45vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.6vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] z-10 font-body text-[1.5vw] tracking-[0.24em] uppercase text-[#9FB4C0]">
        District Demonstration · 2026
      </div>

      <div className="relative z-10 mt-[19vh] max-w-[66vw]">
        <div className="font-body text-[1.6vw] font-semibold tracking-[0.3em] uppercase text-[#2DD4BF]">
          For District Leadership
        </div>
        <h1 className="mt-[3vh] font-display text-[6.6vw] font-bold leading-[1.0] tracking-[-0.035em] text-balance">
          The operating system for your schools
        </h1>
        <p className="mt-[4vh] max-w-[52vw] font-body text-[2.2vw] leading-[1.4] text-[#B9C9D3] text-pretty">
          One connected platform for students, teachers, families, and administrators — shown end to end.
        </p>
      </div>

      <svg
        viewBox="0 0 1200 60"
        preserveAspectRatio="none"
        className="absolute bottom-[13vh] left-0 z-10 h-[6vh] w-full"
      >
        <polyline
          points="0,30 470,30 512,30 538,8 560,52 584,30 636,30 658,17 680,43 702,30 1200,30"
          fill="none"
          stroke="#15B8A6"
          strokeWidth="2.5"
        />
      </svg>

      <div className="absolute bottom-[5vh] left-[6vw] z-10 font-body text-[1.5vw] tracking-[0.04em] text-[#8FA6B3]">
        D.S. Parrott Middle School
      </div>
      <div className="absolute bottom-[5vh] right-[6vw] z-10 font-body text-[1.5vw] tracking-[0.04em] text-[#8FA6B3]">
        A single, actionable platform
      </div>
    </div>
  );
}

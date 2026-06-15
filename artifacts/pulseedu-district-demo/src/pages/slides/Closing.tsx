export default function Closing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0B1F33] text-[#EAF2F0] font-body px-[6vw] py-[6vh]">
      <div className="absolute inset-0 bg-[radial-gradient(120%_100%_at_50%_0%,#16314a_0%,#0B1F33_60%)]" />

      <div className="absolute top-[5vh] left-[6vw] z-10 flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] z-10 font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#9FB4C0]">
        The Operating System for Schools
      </div>

      <svg
        viewBox="0 0 1200 60"
        preserveAspectRatio="none"
        className="absolute top-[64vh] left-0 z-10 h-[5vh] w-full opacity-90"
      >
        <polyline
          points="0,30 470,30 498,8 522,52 546,30 1200,30"
          fill="none"
          stroke="#15B8A6"
          strokeWidth="2.5"
        />
      </svg>

      <div className="relative z-10 flex h-full flex-col justify-center max-w-[78vw]">
        <h1 className="font-display text-[4vw] font-bold leading-[1.12] tracking-[-0.035em] text-balance">
          PulseEDU is not another software product. It is the operating system that connects students, teachers, families, and administrators into a single, actionable platform.
        </h1>

        <div className="mt-[6vh] flex items-center gap-[1.5vw]">
          <div className="font-display text-[2vw] font-bold text-[#2DD4BF]">D.S. Parrott Middle</div>
          <div className="h-[1.6vw] w-px bg-[#3A5168]" />
          <div className="font-body text-[2vw] text-[#B9C9D3]">Where Leaders Are Unleashed</div>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[6vw] z-10 font-body text-[1.5vw] tracking-[0.18em] uppercase text-[#7E96A4]">
        Thank you · Let&apos;s talk next steps
      </div>
    </div>
  );
}

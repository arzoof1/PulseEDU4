export default function StudentSupportHeartbeat() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0B1F33] text-[#EAF2F0] font-body px-[6vw] py-[6vh]">
      <div className="absolute inset-0 bg-[radial-gradient(110%_90%_at_15%_20%,#16314a_0%,#0B1F33_60%)]" />

      <div className="absolute top-[5vh] left-[6vw] z-10 flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] z-10 font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#9FB4C0]">
        03 · Student Support
      </div>

      <div className="relative z-10 mt-[15vh] max-w-[74vw]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.3em] uppercase text-[#2DD4BF]">
          HeartBEAT · The Invisible Student
        </div>
        <h1 className="mt-[3vh] font-display text-[5vw] font-bold leading-[1.04] tracking-[-0.035em] text-balance">
          Every student should be known by someone.
        </h1>
        <p className="mt-[4vh] max-w-[60vw] font-body text-[2.2vw] leading-[1.4] text-[#B9C9D3] text-pretty">
          Some students aren&apos;t failing and aren&apos;t in trouble — so no one is watching. They can go a whole year without a single meaningful adult connection. HeartBEAT finds them before that happens.
        </p>
      </div>

      <svg
        viewBox="0 0 1200 60"
        preserveAspectRatio="none"
        className="absolute bottom-[16vh] left-0 z-10 h-[5vh] w-full"
      >
        <polyline
          points="0,30 520,30 548,9 572,51 596,30 1200,30"
          fill="none"
          stroke="#15B8A6"
          strokeWidth="2.5"
        />
      </svg>

      <div className="absolute bottom-[5vh] left-[6vw] z-10 inline-flex items-center gap-[0.8vw] rounded-[0.6vw] bg-[#15B8A6] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#06342E]">Live demo</span>
        <span className="font-body text-[1.5vw] font-medium text-[#06342E]">Noah Xu — flagged invisible, with full connection history</span>
      </div>
    </div>
  );
}

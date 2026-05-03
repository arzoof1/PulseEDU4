export default function Closing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">Confidential pitch · 2026</div>

      <div className="mt-[10vh] flex h-[78vh]">
        <div className="flex-1 flex flex-col justify-center pr-[4vw]">
          <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">CLOSING</div>
          <h1 className="mt-[2vh] text-[8vw] font-extrabold leading-[1.02] tracking-[-0.04em] text-balance">
            Let's talk.
          </h1>
          <p className="mt-[3vh] max-w-[40vw] text-[1.6vw] leading-[1.4] text-[#5A5A6E] text-pretty">
            We'll bring a sandbox seeded with your school. You'll see your real rosters and your real workflows in PulseEDU within a week.
          </p>
        </div>

        <div className="w-[35vw] flex flex-col justify-center gap-[3vh]">
          <div className="rounded-[1.5vw] bg-[#E0E7ED] px-[2.5vw] py-[3vh]">
            <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">CONTACT</div>
            <div className="mt-[1.5vh] text-[2vw] font-extrabold leading-[1.1]">[ Your name ]</div>
            <div className="mt-[0.5vh] text-[1.3vw] text-[#5A5A6E]">PulseEDU</div>
          </div>
          <div className="rounded-[1.5vw] bg-[#E1EDE4] px-[2.5vw] py-[3vh]">
            <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">EMAIL</div>
            <div className="mt-[1.5vh] text-[1.8vw] font-bold">[ your.email@pulseedu.com ]</div>
          </div>
          <div className="rounded-[1.5vw] bg-[#F0E4D8] px-[2.5vw] py-[3vh]">
            <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DEMO</div>
            <div className="mt-[1.5vh] text-[1.5vw] leading-[1.35] text-pretty">Book a walkthrough — we'll seed a sandbox with your school's data.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

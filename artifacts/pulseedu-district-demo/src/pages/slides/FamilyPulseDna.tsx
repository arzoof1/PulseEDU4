export default function FamilyPulseDna() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0B1F33] text-[#EAF2F0] font-body px-[6vw] py-[6vh]">
      <div className="absolute inset-0 bg-[radial-gradient(120%_95%_at_85%_15%,#16314a_0%,#0B1F33_58%)]" />

      <div className="absolute top-[5vh] left-[6vw] z-10 flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] z-10 font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#9FB4C0]">
        06 · Family Communication
      </div>

      <div className="relative z-10 mt-[8.5vh]">
        <div className="font-body text-[1.5vw] font-semibold tracking-[0.28em] uppercase text-[#2DD4BF]">
          PulseDNA AI
        </div>
        <h1 className="mt-[1.5vh] font-display text-[3vw] font-bold leading-[1.12] tracking-[-0.03em] max-w-[68vw] text-balance">
          AI should not replace the principal&apos;s voice. It should learn the school&apos;s voice.
        </h1>
      </div>

      <div className="relative z-10 mt-[5vh] flex items-stretch gap-[2vw]">
        <div className="w-[30vw] rounded-[1vw] bg-[#11293E] border border-[#2DD4BF]/25 px-[2vw] py-[2.8vh] flex flex-col">
          <div className="font-body text-[1.5vw] font-bold tracking-[0.16em] uppercase text-[#9FB4C0]">A rough idea, typed in</div>
          <p className="mt-[1.8vh] font-display text-[2vw] font-medium leading-[1.3] text-[#EAF2F0]">
            &ldquo;Volleyball team won tonight. Great crowd. Proud of our kids.&rdquo;
          </p>
          <div className="mt-auto pt-[2vh] font-body text-[1.5vw] text-[#7E96A4]">Stored Communication DNA does the rest.</div>
        </div>

        <div className="flex items-center font-display text-[2.4vw] text-[#15B8A6]">→</div>

        <div className="flex-1 grid grid-cols-3 gap-[1.4vw]">
          <div className="rounded-[1vw] bg-[#15B8A6] px-[1.6vw] py-[2.8vh] flex flex-col">
            <div className="font-display text-[2vw] font-bold text-[#06342E]">Family message</div>
            <p className="mt-[1.4vh] font-body text-[1.5vw] leading-[1.25] text-[#06342E]/85">Ready to send to every family inbox.</p>
          </div>
          <div className="rounded-[1vw] bg-[#F2A33C] px-[1.6vw] py-[2.8vh] flex flex-col">
            <div className="font-display text-[2vw] font-bold text-[#3D2705]">Social post</div>
            <p className="mt-[1.4vh] font-body text-[1.5vw] leading-[1.25] text-[#3D2705]/85">On-brand and ready to publish.</p>
          </div>
          <div className="rounded-[1vw] bg-[#EAF2F0] px-[1.6vw] py-[2.8vh] flex flex-col">
            <div className="font-display text-[2vw] font-bold text-[#0B1F33]">Teleprompter script</div>
            <p className="mt-[1.4vh] font-body text-[1.5vw] leading-[1.25] text-[#0B1F33]/70">For the morning announcement.</p>
          </div>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[6vw] z-10 inline-flex items-center gap-[0.8vw] rounded-[0.6vw] bg-[#15B8A6] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#06342E]">Live demo</span>
        <span className="font-body text-[1.5vw] font-medium text-[#06342E]">Generate all three from one idea — in the school&apos;s saved voice</span>
      </div>
    </div>
  );
}

export default function Agenda() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        District Demonstration
      </div>

      <h1 className="mt-[8vh] font-display text-[3.6vw] font-bold tracking-[-0.03em]">
        The demonstration flow
      </h1>
      <p className="mt-[1.5vh] font-body text-[2vw] text-[#5B6B79]">
        Eight connected experiences — one school day, one platform.
      </p>

      <div className="mt-[4.5vh] grid grid-cols-2 gap-x-[5vw] gap-y-[2.6vh]">
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">01</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">Student Experience</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">Hall pass, attendance, recognition, the points store, sign-in</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">02</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">Teacher Experience</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">Roster, benchmarks, small groups, accommodations</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">03</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">Student Support</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">HeartBEAT — no student is invisible</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">04</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">MTSS Interventions</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">Tier 2 and Tier 3, documented over time</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">05</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">AST &amp; Comp Time</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">A full five-step approval workflow</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">06</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">Family Communication</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">PulseDNA AI in the school&apos;s own voice</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">07</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">Leadership Intelligence</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">Insights and FAST coverage</div>
          </div>
        </div>
        <div className="flex items-start gap-[1.4vw]">
          <span className="font-display text-[2.6vw] font-bold leading-none text-[#F2A33C] w-[3.4vw]">08</span>
          <div>
            <div className="font-display text-[2vw] font-bold tracking-[-0.01em]">School Operations</div>
            <div className="font-body text-[1.5vw] text-[#5B6B79]">Event ticketing and digital signage</div>
          </div>
        </div>
      </div>
    </div>
  );
}

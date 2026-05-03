export default function Problem() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">02 / 18</div>

      <div className="mt-[7vh] max-w-[75vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">THE PROBLEM</div>
        <h1 className="mt-[1.5vh] text-[4.2vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          Schools are running on six systems that don't talk to each other.
        </h1>
      </div>

      <div className="mt-[6vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2.5vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DISCONNECTED TOOLS</div>
          <p className="mt-[1.5vh] text-[1.6vw] leading-[1.4] text-pretty">Behavior is in one tool, MTSS plans in another, hall passes on paper, tardies in a spreadsheet.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">FAMILIES IN THE DARK</div>
          <p className="mt-[1.5vh] text-[1.6vw] leading-[1.4] text-pretty">Parents hear from the school once a quarter, by email blast.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DUPLICATE DATA ENTRY</div>
          <p className="mt-[1.5vh] text-[1.6vw] leading-[1.4] text-pretty">Front-office staff retype the same student data three times a week.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">NO SINGLE VIEW</div>
          <p className="mt-[1.5vh] text-[1.6vw] leading-[1.4] text-pretty">Leadership has no single dashboard that says "how is this kid actually doing?"</p>
        </div>
      </div>
    </div>
  );
}

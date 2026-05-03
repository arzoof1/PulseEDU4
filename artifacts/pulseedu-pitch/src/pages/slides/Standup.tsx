export default function Standup() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">04 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DEPLOYMENT</div>
        <h1 className="mt-[1.5vh] text-[4.5vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          How a school stands it up.
        </h1>
      </div>

      <div className="mt-[7vh] grid grid-cols-4 gap-[1.5vw]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[1.8vw] py-[3.5vh] h-[42vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WEEK 1</div>
          <div className="mt-[1vh] text-[2.4vw] font-extrabold leading-[1.05]">Roster import</div>
          <p className="mt-auto text-[1.4vw] leading-[1.4] text-pretty text-[#1A1A2E]">District admin imports staff and student rosters from one CSV per school.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[1.8vw] py-[3.5vh] h-[42vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WEEK 2</div>
          <div className="mt-[1vh] text-[2.4vw] font-extrabold leading-[1.05]">Roles assigned</div>
          <p className="mt-auto text-[1.4vw] leading-[1.4] text-pretty">School admin assigns roles — Teacher, Dean, BS, MTSS Coord, ESE, Counselor — from a single screen.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[1.8vw] py-[3.5vh] h-[42vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WEEK 3</div>
          <div className="mt-[1vh] text-[2.4vw] font-extrabold leading-[1.05]">Modules on</div>
          <p className="mt-auto text-[1.4vw] leading-[1.4] text-pretty">Features turn on per school based on the tier the district purchased.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[1.8vw] py-[3.5vh] h-[42vh] flex flex-col">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WEEK 4</div>
          <div className="mt-[1vh] text-[2.4vw] font-extrabold leading-[1.05]">Login day</div>
          <p className="mt-auto text-[1.4vw] leading-[1.4] text-pretty">Teachers and parents log in — no separate passwords.</p>
        </div>
      </div>
    </div>
  );
}

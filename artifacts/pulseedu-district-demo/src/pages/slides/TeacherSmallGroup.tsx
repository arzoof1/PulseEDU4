export default function TeacherSmallGroup() {
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
          Small Groups &amp; Accommodations
        </div>
        <h1 className="mt-[1.2vh] font-display text-[3.4vw] font-bold leading-[1.04] tracking-[-0.03em]">
          Support, documented over time
        </h1>
      </div>

      <div className="mt-[4.5vh] flex h-[52vh] gap-[3vw]">
        <div className="flex-1 rounded-[1vw] bg-[#E3F0EC] border border-[#15B8A6]/30 px-[2.4vw] py-[3vh] flex flex-col">
          <div className="font-display text-[1.6vw] font-bold tracking-[0.12em] uppercase text-[#0F8C7E]">Small Group Instruction</div>
          <div className="mt-[2.4vh] flex flex-col gap-[2.2vh]">
            <p className="font-body text-[2vw] leading-[1.3]">
              Find students with the same skill gap straight from benchmark data.
            </p>
            <p className="font-body text-[2vw] leading-[1.3]">
              Form a group, then log each session of targeted support as it happens.
            </p>
            <p className="font-body text-[2vw] leading-[1.3]">
              A running history shows how the group changes over weeks.
            </p>
          </div>
        </div>

        <div className="flex-1 rounded-[1vw] bg-[#F7EBD8] border border-[#F2A33C]/40 px-[2.4vw] py-[3vh] flex flex-col">
          <div className="font-display text-[1.6vw] font-bold tracking-[0.12em] uppercase text-[#B9772A]">Classroom Accommodations</div>
          <div className="mt-[2.4vh] flex flex-col gap-[2.2vh]">
            <p className="font-body text-[2vw] leading-[1.3]">
              Each student&apos;s required accommodations are listed where the teacher teaches.
            </p>
            <p className="font-body text-[2vw] leading-[1.3]">
              504, ESE, and ELL supports are visible at the moment of instruction.
            </p>
            <p className="font-body text-[2vw] leading-[1.3]">
              Compliance becomes part of the daily workflow, not a binder.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-[3.5vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
        <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
        <span className="font-body text-[1.5vw] text-[#EAF2F0]">Pamela Martin — accommodations for five students in ELA, Grade 7</span>
      </div>
    </div>
  );
}

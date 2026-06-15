export default function StudentHallPass() {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        01 · Student Experience
      </div>

      <div className="mt-[9vh] flex h-[74vh] gap-[4vw]">
        <div className="w-[44vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            Hall Pass &amp; Kiosk
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.5vw] font-bold leading-[1.05] tracking-[-0.03em]">
            A day in the life of a student
          </h1>

          <div className="mt-[4vh] flex flex-col gap-[2.4vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                A student scans an ID at the door kiosk and picks a destination — no paper, no waiting on a teacher.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                When a destination is at capacity, students join a period-aware waiting line that resets on the bell.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Teachers run a Companion Queue and can push a student through with a one-tap &ldquo;Go Now.&rdquo;
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                A live timer tracks the pass, and the student checks back in on return.
              </p>
            </div>
          </div>

          <div className="mt-[4vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
            <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
            <span className="font-body text-[1.5vw] text-[#EAF2F0]">Amy Brown&apos;s room — queue, Go Now, return</span>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="w-full overflow-hidden rounded-[1vw] border border-[#0B1F33]/12 bg-white shadow-[0_2vh_4vh_rgba(11,31,51,0.14)]">
            <img
              src={`${base}shots/kiosk.jpg`}
              alt="PulseEDU door kiosk for student hall passes"
              className="block w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

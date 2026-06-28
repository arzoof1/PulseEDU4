export default function StudentSelfService() {
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
        <div className="w-[46vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            Student Sign-In
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.3vw] font-bold leading-[1.07] tracking-[-0.03em]">
            Students see their own progress
          </h1>

          <div className="mt-[4vh] flex flex-col gap-[2.6vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Students sign in with ClassLink — the same single sign-on they already use.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Their HeartBEAT shows points, recognitions, and goals in one place.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                They redeem rewards themselves, straight from their own balance.
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="w-full rounded-[1vw] border border-[#0B1F33]/12 bg-[#0B1F33] px-[2.2vw] py-[3vh] shadow-[0_2vh_4vh_rgba(11,31,51,0.18)]">
            <div className="font-body text-[1.4vw] tracking-[0.2em] uppercase text-[#2DD4BF]">What a student sees</div>
            <div className="mt-[2.4vh] flex items-end justify-between border-b border-white/12 pb-[2vh]">
              <span className="font-body text-[1.7vw] text-[#C7D6DE]">Points balance</span>
              <span className="font-display text-[3vw] font-bold text-[#EAF2F0]">1,240</span>
            </div>
            <div className="mt-[2vh] flex items-center justify-between">
              <span className="font-body text-[1.7vw] text-[#C7D6DE]">My recognitions</span>
              <span className="font-body text-[1.7vw] text-[#EAF2F0]">This week</span>
            </div>
            <div className="mt-[1.6vh] flex items-center justify-between">
              <span className="font-body text-[1.7vw] text-[#C7D6DE]">My goals</span>
              <span className="font-body text-[1.7vw] text-[#EAF2F0]">On track</span>
            </div>
            <div className="mt-[2.6vh] inline-flex w-fit items-center gap-[0.6vw] rounded-[0.5vw] bg-[#15B8A6] px-[1.2vw] py-[1vh]">
              <span className="font-body text-[1.5vw] font-bold tracking-[0.1em] uppercase text-[#0B1F33]">Redeem in the store</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

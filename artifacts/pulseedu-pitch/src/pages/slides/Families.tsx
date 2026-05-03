export default function Families() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F0F2F5] text-[#1A1A2E] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] text-[1.2vw] font-bold tracking-tight">PulseEDU</div>
      <div className="absolute top-[5vh] right-[6vw] text-[1.2vw] text-[#888]">10 / 18</div>

      <div className="mt-[7vh] max-w-[80vw]">
        <div className="text-[1.1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">ROLE 05 / FAMILIES</div>
        <h1 className="mt-[1.5vh] text-[4.2vw] font-extrabold leading-[1.05] tracking-[-0.02em] text-balance">
          The HeartBEAT Parent Portal.
        </h1>
      </div>

      <div className="mt-[6vh] grid grid-cols-2 gap-x-[2vw] gap-y-[2.5vh]">
        <div className="rounded-[1.2vw] bg-[#E0E7ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">DAILY VIEW</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">See their child's PBIS points, hall passes, tardies, and recent behavior notes by logging into the parent portal.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E1EDE4] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">TWO-WAY MESSAGING</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Read messages from teachers and reply by tapping the message in the inbox.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#F0E4D8] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">SUPPORTS TAB</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">See their child's accommodations and intervention plan by opening the "Supports" tab.</p>
        </div>
        <div className="rounded-[1.2vw] bg-[#E8E0ED] px-[2vw] py-[3vh]">
          <div className="text-[1vw] font-bold tracking-[0.18em] text-[#5A5A6E]">WEEKLY DIGEST</div>
          <p className="mt-[1.5vh] text-[1.55vw] leading-[1.4] text-pretty">Subscribe to weekly summary emails by opting in once at sign-up.</p>
        </div>
      </div>
    </div>
  );
}

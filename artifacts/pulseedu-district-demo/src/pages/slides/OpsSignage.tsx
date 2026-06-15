export default function OpsSignage() {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#F3EFE6] text-[#0B1F33] font-body px-[6vw] py-[6vh]">
      <div className="absolute top-[5vh] left-[6vw] flex items-center gap-[0.8vw]">
        <div className="h-[1.6vw] w-[1.6vw] rounded-[0.4vw] bg-[#15B8A6]" />
        <span className="font-display text-[1.5vw] font-bold tracking-[-0.02em]">PulseEDU</span>
      </div>
      <div className="absolute top-[5vh] right-[6vw] font-body text-[1.5vw] tracking-[0.2em] uppercase text-[#5B6B79]">
        08 · School Operations
      </div>

      <div className="mt-[8vh] flex h-[76vh] gap-[4vw]">
        <div className="w-[42vw] flex flex-col justify-center">
          <div className="font-body text-[1.5vw] font-semibold tracking-[0.26em] uppercase text-[#15B8A6]">
            Display Management
          </div>
          <h1 className="mt-[1.5vh] font-display text-[3.4vw] font-bold leading-[1.05] tracking-[-0.03em]">
            Every TV, driven from one place
          </h1>

          <div className="mt-[3.5vh] flex flex-col gap-[2.4vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Per-school playlists mix images, video, PBIS house standings, and live hall passes.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                Live Remote Control drives every screen PowerPoint-style — auto, manual, or presentation.
              </p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="mt-[0.7vh] h-[1vw] w-[1vw] rounded-full bg-[#F2A33C] shrink-0" />
              <p className="font-body text-[2vw] leading-[1.3]">
                No URLs to re-enter — change the message once and every TV follows.
              </p>
            </div>
          </div>

          <div className="mt-[4vh] inline-flex w-fit items-center gap-[0.8vw] rounded-[0.6vw] bg-[#0B1F33] px-[1.4vw] py-[1.1vh]">
            <span className="font-body text-[1.5vw] font-bold tracking-[0.18em] uppercase text-[#2DD4BF]">Live demo</span>
            <span className="font-body text-[1.5vw] text-[#EAF2F0]">Push a slide to every screen from Remote Control</span>
          </div>
        </div>

        <div className="flex-1 flex items-center">
          <div className="w-full overflow-hidden rounded-[1vw] border border-[#0B1F33]/12 bg-[#0B1F33] shadow-[0_2vh_4vh_rgba(11,31,51,0.16)]">
            <img
              src={`${base}shots/signage-houses.jpg`}
              alt="Digital signage showing PBIS house standings"
              className="block w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

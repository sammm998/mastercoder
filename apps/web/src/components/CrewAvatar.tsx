import { avatarSrc, CREW_COLOR, CREW_NAME, type CrewId } from "@/lib/crew";

/** A crew mascot in a soft tinted circle. Decorative unless `labelled` (then the name is the alt text). */
export function CrewAvatar({ id, size = 36, labelled = false }: { id: CrewId; size?: number; labelled?: boolean }) {
  return (
    <span className="crew-avatar" style={{ ["--s" as string]: `${size}px`, ["--c" as string]: CREW_COLOR[id] }} data-crew={id}>
      <img src={avatarSrc(id)} width={size} height={size} alt={labelled ? CREW_NAME[id] : ""} aria-hidden={labelled ? undefined : true} loading="lazy" decoding="async" />
    </span>
  );
}

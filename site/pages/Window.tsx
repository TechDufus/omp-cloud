import type { CSSProperties, ReactNode } from "react";
import type { ImageRegistry, ImageRef } from "../assets";

interface WinProps {
  /** The path shown after `localhost:8081`, for example `/ overview`. No address bar when omitted. */
  address?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** A window frame: hairline border, optional address bar with three dots (ported from scripts/showcase/compose). */
export function Win({ address, className, style, children }: WinProps) {
  return (
    <div className={className ? `win ${className}` : "win"} style={style}>
      {address !== undefined ? (
        <div className="win-bar">
          <i />
          <i />
          <i />
          <span className="win-addr">
            localhost:8081 <b>{address}</b>
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

interface ThemedShotProps {
  /** A docs/assets screenshot stem; the `-dark` and `-light` PNGs must both exist. */
  name: string;
  alt: string;
  images: ImageRegistry;
  /** The page's rootPrefix. */
  prefix: string;
}

function ShotImage({ image, theme, alt, prefix }: { image: ImageRef; theme: "dark" | "light"; alt: string; prefix: string }) {
  return (
    <img
      src={prefix + image.file}
      alt={alt}
      width={image.width}
      height={image.height}
      loading="lazy"
      decoding="async"
      data-theme-only={theme}
    />
  );
}

/** One screenshot in both themes; site.css shows the image that matches `html[data-theme]`. */
export function ThemedShot({ name, alt, images, prefix }: ThemedShotProps) {
  return (
    <>
      <ShotImage image={images.shot(`${name}-dark`)} theme="dark" alt={alt} prefix={prefix} />
      <ShotImage image={images.shot(`${name}-light`)} theme="light" alt={alt} prefix={prefix} />
    </>
  );
}

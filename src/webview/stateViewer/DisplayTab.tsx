import { DisplayState, AmigaColor, AmigaColor256 } from "../../shared/stateViewerTypes";
import { ScreenGeometry } from "./ScreenGeometry";
import "./DisplayTab.css";

interface DisplayTabProps {
  displayState: DisplayState;
}

export function DisplayTab({ displayState }: DisplayTabProps) {
  const {
    palette,
    aga256Palette,
    bitplanes,
    interlaced,
    hires,
    shres,
    ham,
    hamBits,
    dpf,
    pf2h,
    pf1h,
    pf2Pri,
    pf2p,
    pf1p,
    ecsEna,
    borderSprites,
    borderTransparent,
    borderBlank,
    isAga,
    fetchMode,
    bplam,
    esprm,
    osprm,
  } = displayState;

  // Convert 4-bit RGB to 8-bit hex string (e.g., 0x018f becomes #1188ff)
  const toHexColor = (color: AmigaColor): string => {
    // Amiga 4-bit to 8-bit: replicate the nibble (0xF becomes 0xFF, 0x1 becomes 0x11)
    const r = (color.r << 4) | color.r;
    const g = (color.g << 4) | color.g;
    const b = (color.b << 4) | color.b;
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  };

  // AGA's 256-entry palette is already 8-bit/channel — no nibble expansion needed.
  const toHexColor256 = (color: AmigaColor256): string =>
    `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}`;

  const resolutionLabel = shres ? "Super Hi-Res" : hires ? "Hi-Res" : "Lo-Res";
  const fetchModeLabel = fetchMode !== undefined ? `${1 << fetchMode}x` : undefined;

  return (
    <div className="display-tab">
      <section className="display-section">
        <div className="config-grid">
          <div className="config-list">
            <div className="config-item">
              <span className="config-label">Bitplanes:</span>
              <span className="config-value">{bitplanes}</span>
            </div>
            <div className="config-item">
              <span className="config-label">Resolution:</span>
              <span className="config-value">{resolutionLabel}</span>
            </div>
            <div className="config-item">
              <span className="config-label">Interlaced:</span>
              <span className="config-value">
                {interlaced ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className="config-item">
              <span className="config-label">HAM:</span>
              <span className="config-value">
                {ham ? (
                  hamBits ? `HAM${hamBits}` : <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className="config-item">
              <span className="config-label">Dual Playfield:</span>
              <span className="config-value">
                {dpf ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            {/* TODO: pf1/pf2 scroll, playfield priorities */}
          </div>
          <div className="config-list">
            <div className="config-item">
              <span className="config-label">PF1 scroll:</span>
              <span className="config-value">{pf1h}</span>
            </div>
            <div className="config-item">
              <span className="config-label">PF2 scroll:</span>
              <span className="config-value">{pf2h}</span>
            </div>
            <div className="config-item">
              <span className="config-label">PF2 over PF1:</span>
              <span className="config-value">
                {pf2Pri ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className="config-item">
              <span className="config-label">PF1 priority:</span>
              <span className="config-value">{pf1p}</span>
            </div>
            <div className="config-item">
              <span className="config-label">PF2 priority:</span>
              <span className="config-value">{pf2p}</span>
            </div>
          </div>
          <div className="config-list">
            <div className="config-item">
              <span className="config-label">ECS Enabled:</span>
              <span className="config-value">
                {ecsEna ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className={ecsEna ? "config-item" : "config-item disabled"}>
              <span className="config-label">Border Sprites:</span>
              <span className="config-value">
                {borderSprites ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className={ecsEna ? "config-item" : "config-item disabled"}>
              <span className="config-label">Border Trans:</span>
              <span className="config-value">
                {borderTransparent ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
            <div className={ecsEna ? "config-item" : "config-item disabled"}>
              <span className="config-label">Border Blanked:</span>
              <span className="config-value">
                {borderBlank ? (
                  <vscode-icon name="check"></vscode-icon>
                ) : (
                  <vscode-icon name="close"></vscode-icon>
                )}
              </span>
            </div>
          </div>
          {isAga && (
            <div className="config-list">
              <div className="config-item">
                <span className="config-label">Fetch Mode:</span>
                <span className="config-value">{fetchModeLabel}</span>
              </div>
              <div className="config-item">
                <span className="config-label">BPLAM:</span>
                <span className="config-value">
                  ${(bplam ?? 0).toString(16).toUpperCase().padStart(2, "0")}
                </span>
              </div>
              <div className="config-item">
                <span className="config-label">ESPRM:</span>
                <span className="config-value">{esprm}</span>
              </div>
              <div className="config-item">
                <span className="config-label">OSPRM:</span>
                <span className="config-value">{osprm}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <vscode-divider></vscode-divider>

      <section className="display-section">
        <h2>Color Palette{aga256Palette ? " (AGA, 256 colours)" : ""}</h2>
        <div className={aga256Palette ? "palette-grid palette-grid-256" : "palette-grid"}>
          {aga256Palette
            ? aga256Palette.map((color) => {
                const hexColor = toHexColor256(color);
                const amigaRgb = `#${color.r.toString(16).toUpperCase().padStart(2, "0")}${color.g.toString(16).toUpperCase().padStart(2, "0")}${color.b.toString(16).toUpperCase().padStart(2, "0")}`;
                return (
                  <div
                    key={color.register}
                    className="color-tile"
                    style={{ backgroundColor: hexColor }}
                  >
                    <div className="color-info">
                      <div className="color-index">
                        {String(color.register).padStart(3, "0")}:
                      </div>
                      <div className="color-hex">{amigaRgb}</div>
                    </div>
                  </div>
                );
              })
            : palette.map((color) => {
                const hexColor = toHexColor(color);
                const amigaRgb = `$${color.r.toString(16).toUpperCase()}${color.g.toString(16).toUpperCase()}${color.b.toString(16).toUpperCase()}`;
                return (
                  <div
                    key={color.register}
                    className="color-tile"
                    style={{ backgroundColor: hexColor }}
                  >
                    <div className="color-info">
                      <div className="color-index">
                        COLOR{String(color.register).padStart(2, "0")}:
                      </div>
                      <div className="color-hex">{amigaRgb}</div>
                    </div>
                  </div>
                );
              })}
        </div>
      </section>

      <vscode-divider></vscode-divider>

      <section className="display-section">
        <h2>Geometry</h2>
        <ScreenGeometry displayState={displayState} />
      </section>
    </div>
  );
}

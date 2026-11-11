import { TranscriptSegment } from "@/config/types";
import { extractBasicInfo, VideoBasicInfo } from "./metadataExtractor";

export const getYoutubeHtml = async (videoId: string) => {
  const isMobileYouTube = window.location.hostname === "m.youtube.com";
  const baseUrl = isMobileYouTube
    ? "https://m.youtube.com"
    : "https://www.youtube.com";
  const videoUrl = `${baseUrl}/watch?v=${videoId}`;

  const response = await fetch(videoUrl, {
    mode: "same-origin",
    credentials: "omit",
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      ...(isMobileYouTube && {
        "User-Agent": navigator.userAgent,
        "X-Requested-With": "XMLHttpRequest",
      }),
    },
  });

  if (!response.ok) {
    throw new Error("Transcript query failed. Failed to fetch video page");
  }

  return await response.text();
};

export const getTranscript = async (
  videoId: string,
  maxTranscriptAttempts: number = 5
) => {
  let transcript = null;
  let basicInfo = {
    title: "",
    chapters: "",
  } as VideoBasicInfo;

  for (let attempt = 1; attempt <= maxTranscriptAttempts; attempt++) {
    try {
      console.log(
        `Attempting to get transcript (attempt ${attempt}/${maxTranscriptAttempts})`
      );
      const youtubeHtml = await getYoutubeHtml(videoId);
      basicInfo = extractBasicInfo(youtubeHtml);
      transcript = await attemptGetTranscript(youtubeHtml);

      // Check if transcript is valid (not null/undefined and has content)
      if (transcript && transcript.length > 0) {
        console.log(`Successfully got transcript on attempt ${attempt}`);
        return {
          ...basicInfo,
          transcript,
        };
      } else {
        console.log(
          `Transcript attempt ${attempt} returned empty/null transcript`
        );
        if (attempt === maxTranscriptAttempts) {
          console.log(
            `All ${maxTranscriptAttempts} transcript attempts failed, proceeding without transcript`
          );
          break;
        }
      }
    } catch (error) {
      console.log(`Transcript attempt ${attempt} failed with error:`, error);
      if (attempt === maxTranscriptAttempts) {
        console.log(
          `All ${maxTranscriptAttempts} transcript attempts failed, proceeding without transcript`
        );
        break;
      }
    }

    // Wait before retrying (exponential backoff)
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 2000); // Cap at 2 seconds
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    "Sometimes transcript retrieval fails and requires multiple attempts."
  );
};

export const attemptGetTranscript = async (youtubeHtml: string) => {
  // YouTube timedtext URLs now return empty bodies. Read the transcript
  // from YouTube's own "Show transcript" panel first.
  const domTranscript = await getTranscriptFromPage();
  if (domTranscript?.length) return domTranscript;

  const isMobileYouTube = window.location.hostname === "m.youtube.com";
  const baseUrl = isMobileYouTube
    ? "https://m.youtube.com"
    : "https://www.youtube.com";

  // get default browser language transcript
  const browserLanguage = navigator.language;

  const preferredLangs = [browserLanguage, "en", null];
  let match = null;

  for (const lang of preferredLangs) {
    const pattern = lang
      ? new RegExp(
          `(?:https:\/\/(?:www|m)\\.youtube\\.com)?\/api\/timedtext\\?[^"']+lang=${lang}[^"']*`
        )
      : /(?:https:\/\/(?:www|m)\.youtube\.com)?\/api\/timedtext\?[^"']+lang=[a-z-]+[^"']*/i;

    match = youtubeHtml.match(pattern);
    if (match) break;
  }

  if (!match) {
    return null;
  }

  let transcriptUrl = match[0];

  // If it's a relative URL (like when on mobile), use the same domain we made the original request to
  if (transcriptUrl.startsWith("/")) {
    transcriptUrl = `${baseUrl}${transcriptUrl}`;
  }
  // Normalize the URL by replacing Unicode-escaped ampersands
  transcriptUrl = match[0].replace(/\\u0026/g, "&");

  const xmlText = await fetchXMLTranscript(transcriptUrl, isMobileYouTube);
  const transcriptSegments = parseXMLTranscript(xmlText);
  const transcript = resegmentTranscript(transcriptSegments);

  return transcript;
};

async function fetchXMLTranscript(
  normalizedTranscriptUrl: string,
  includeAgent: boolean
) {
  try {
    const transcriptResponse = await fetch(normalizedTranscriptUrl, {
      mode: "same-origin",
      credentials: "omit",
      headers: {
        Accept: "*/*",
        ...(includeAgent && {
          "User-Agent": navigator.userAgent,
          "X-Requested-With": "XMLHttpRequest",
        }),
      },
    });

    if (!transcriptResponse.ok) {
      throw new Error("Failed to fetch transcript");
    }
    return await transcriptResponse.text();
  } catch (error) {
    throw Error(`Error fetching transcript: ${error}`);
  }
}

function resegmentTranscript(
  transcriptData: TranscriptSegment[],
  segmentDuration: number = 15 // seconds
): TranscriptSegment[] {
  if (!transcriptData.length) return [];

  const segments: TranscriptSegment[] = [];
  let currentSegment = {
    start: transcriptData[0].start,
    end: transcriptData[0].start + segmentDuration,
    text: [] as string[],
  };

  for (const section of transcriptData) {
    const startTime = section.start;

    // If the current section starts beyond current segment's end,
    // save current segment and start a new one
    if (startTime >= currentSegment.end) {
      // Join the accumulated text and add to segments
      segments.push({
        start: currentSegment.start,
        end: currentSegment.end,
        text: currentSegment.text.join(" ").trim(),
      });

      // Start new segment
      currentSegment = {
        start: currentSegment.end,
        end: currentSegment.end + segmentDuration,
        text: [],
      };
    }

    // Add text to current segment
    const cleanedText = section.text.replace(/&#39;/g, "'");
    currentSegment.text.push(cleanedText);
  }

  // Add the last segment if it has any text
  if (currentSegment.text.length > 0) {
    segments.push({
      start: currentSegment.start,
      end: currentSegment.end,
      text: currentSegment.text.join(" ").trim(),
    });
  }

  return segments;
}

const parseXMLTranscript = (xmlText: string) => {
  try {
    // Create a DOM parser
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Get all text nodes
    const textNodes = xmlDoc.getElementsByTagName("text");

    // Convert to array and map to desired format
    return Array.from(textNodes).map((node) => {
      const start = parseFloat(node.getAttribute("start") || "0");
      const duration = parseFloat(node.getAttribute("dur") || "0");

      return {
        start,
        text: node.textContent || "",
        end: start + duration,
      };
    });
  } catch (error) {
    console.error("Error parsing transcript XML:", error);
    return [];
  }
};

/**
 * Reads the transcript from YouTube's "Show transcript" panel on the current
 * page (desktop only). Opens the panel if needed and closes it afterwards.
 */
async function getTranscriptFromPage(): Promise<TranscriptSegment[] | null> {
  try {
    if (window.location.hostname === "m.youtube.com") return null;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const ROWS = "transcript-segment-view-model, ytd-transcript-segment-renderer";
    const toSeconds = (time?: string | null) => {
      const parts = (time || "").trim().split(":").map(Number);
      if (!parts.length || parts.some(isNaN)) return null;
      return parts.reduce((total, value) => total * 60 + value, 0);
    };

    let opened = false;
    if (!document.querySelector(ROWS)) {
      document
        .querySelector<HTMLElement>("#description-inline-expander #expand, tp-yt-paper-button#expand")
        ?.click();
      await sleep(500);
      const showButton = document.querySelector<HTMLElement>(
        "ytd-video-description-transcript-section-renderer button"
      );
      if (!showButton) return null;
      showButton.click();
      opened = true;
    }

    let rows: Element[] = [];
    for (let i = 0; i < 30; i++) {
      rows = Array.from(document.querySelectorAll(ROWS));
      if (rows.length) break;
      await sleep(500);
    }
    if (!rows.length) return null;
    await sleep(300);
    rows = Array.from(document.querySelectorAll(ROWS));

    const segments: TranscriptSegment[] = [];
    for (const row of rows) {
      let time: string | null | undefined;
      let text: string | null | undefined;
      if (row.tagName === "YTD-TRANSCRIPT-SEGMENT-RENDERER") {
        time = row.querySelector(".segment-timestamp")?.textContent;
        text = row.querySelector(".segment-text")?.textContent;
      } else {
        time = Array.from(row.querySelectorAll("div")).find((div) =>
          /Timestamp$/.test(div.className)
        )?.textContent;
        text = row.querySelector('span[role="text"]')?.textContent;
      }
      const start = toSeconds(time);
      const cleanText = (text || "").replace(/\s+/g, " ").trim();
      if (start === null || !cleanText) continue;
      segments.push({ start, end: start, text: cleanText });
    }
    for (let i = 0; i < segments.length; i++) {
      segments[i].end = i + 1 < segments.length ? segments[i + 1].start : segments[i].start + 5;
    }

    if (opened) {
      document
        .querySelector(
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
        )
        ?.querySelector<HTMLElement>("#visibility-button button, button[aria-label='Close transcript']")
        ?.click();
    }
    return segments.length ? segments : null;
  } catch (error) {
    console.log("Reading transcript from page failed:", error);
    return null;
  }
}

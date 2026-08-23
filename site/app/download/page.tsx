import type { Metadata } from "next";
import { InstallSteps } from "@/components/install-steps";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Downloading Fetch",
  // this page exists to be landed on, never to be found in a search result
  robots: { index: false, follow: false },
};

export default async function DownloadPage({
  searchParams,
}: PageProps<"/download">) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ref) ? sp.ref[0] : sp.ref;
  // same shape the API expects: short, word characters, never arbitrary
  const ref = (raw || "direct").replace(/\W/g, "").slice(0, 24) || "direct";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1200px] px-6 pb-32 pt-40 text-center md:px-10">
        <InstallSteps dmgRef={ref} />
      </main>
    </>
  );
}

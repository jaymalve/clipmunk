import Directed from "@/components/sections/Directed";
import FAQ from "@/components/sections/FAQ";
import FinalCTA from "@/components/sections/FinalCTA";
import Footer from "@/components/sections/Footer";
import Hero from "@/components/sections/Hero";
import Local from "@/components/sections/Local";
import Steps from "@/components/sections/Steps";
import Story from "@/components/sections/Story";
import Take from "@/components/sections/Take";
import UseCases from "@/components/sections/UseCases";
import FxLayer from "@/components/ui/FxLayer";
import Nav from "@/components/ui/Nav";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Take />
        <Story />
        <UseCases />
        <Directed />
        <Steps />
        <Local />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
      <FxLayer />
    </>
  );
}

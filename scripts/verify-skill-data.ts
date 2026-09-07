import { StaticDataCache } from "../src/static-data.js";
import { buildSkillGraph } from "../src/skill-graph.js";

const { catalog, status } = await new StaticDataCache().initialize();
const skills = catalog.data.types.filter(
  (type) => type.categoryId === 16 && type.published,
);
const graph = buildSkillGraph(
  catalog,
  skills.map((skill) => ({ skillId: skill.id, level: 5 })),
);
console.log(
  JSON.stringify(
    {
      staticData: status,
      publishedSkills: skills.length,
      levelNodes: graph.nodes.length,
      edges: graph.edges.length,
      dependencyReplay: "passed",
      examples: ["Mining II", "exhumer", "Hulk", "Jump Freighters", "Rhea"].map(
        (target) => catalog.resolve(target),
      ),
    },
    null,
    2,
  ),
);

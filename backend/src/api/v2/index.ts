import { Router } from "express";
import { responseWrapper } from "../../middleware/responseWrapper.js";

import streamsRouter from "./streams.routes.js";
import statsRouter from "./stats.routes.js";
import adminAssetsRouter from "./admin/assets.routes.js";

const router = Router();

// Apply standard JSON response wrapper to all V2 endpoints
router.use(responseWrapper);

router.use("/streams", streamsRouter);
router.use("/stats", statsRouter);
router.use("/admin/assets", adminAssetsRouter);

export default router;

package com.alienware377.hololoop.model

/**
 * How holograms are shown on the Go. HoloLoop gets these from the PC (its
 * "3D look" page); the phone can override them locally.
 * [depthiness] is the max parallax as a fraction of the picture width.
 */
data class Look(
    val depthiness: Float = 0.32f,
    val focus: Float = 0.5f,
    val fill: Boolean = false,      // false = show the whole picture, true = fill the screen
    val zoom: Float = 1f,
    val iterations: Int = 14,
    val depthInvert: Boolean = false,
    val filterEdge: Boolean = true,
    /** 3D edge fixing, same numbers as the PC: 0 off (original), see [EDGE_MODES]. */
    val edgeFix: Int = 2,
    /** Steady edges: smooth the depth between frames where the picture is still. 0 off, 1 normal, 2 strong. */
    val steady: Int = 1,
    /** The same where something moves (the edge against the background). 0 off, 1 light, 2 strong. */
    val steadyMove: Int = 1,
) {
    companion object {
        /** Names for [edgeFix], in order. */
        val STEADY_MODES = listOf("Off", "Normal", "Strong")
        val MOVE_MODES = listOf("Off", "Light", "Strong")
        val SMOOTHNESS = listOf(8 to "Light", 14 to "Balanced", 24 to "Best")
        val EDGE_MODES = listOf("Off (original)", "Clean colours", "Clean + fill gaps", "Fill gaps + calmer sides", "Best quality (slow)")
    }
}

<script>
    import Terminal from "../../Terminal.svelte";
</script>

<div id="main-terminal">
    <Terminal />
</div>

<style>
    :global(body) {
        background-color: #242426;
        margin: .5%;
    }

    :global(input) {
        font-size: 14px !important;
        margin: 0;
        padding: 0;
    }
</style>
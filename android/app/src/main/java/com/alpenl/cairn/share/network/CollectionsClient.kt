package com.alpenl.cairn.share.network

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class CollectionApiError(val code: String, val status: Int) : IOException(code)
internal class CollectionsClient(private val base: String) {
    suspend fun request(token: String, path: String, body: String? = null): JSONObject {
        return if(body == null) cancellableRead { read(token,path,null,it) }
        else withContext(Dispatchers.IO) { read(token,path,body,null) }
    }
    private fun read(token: String, path: String, body: String?, cancellation: ReadCancellation?): JSONObject {
        val c=URL("${base.trimEnd('/')}/api/collections$path").openConnection() as HttpURLConnection
        try {
            c.instanceFollowRedirects=false;c.connectTimeout=10000;c.readTimeout=20000
            c.setRequestProperty("Authorization","Bearer ${token.trim()}");c.setRequestProperty("X-Cairn-Collections","1");c.setRequestProperty("User-Agent",AppUserAgent.value())
            if(body != null) {
                c.requestMethod="POST";c.doOutput=true;c.setRequestProperty("Content-Type","application/json")
                val bytes=body.toByteArray(Charsets.UTF_8);c.setFixedLengthStreamingMode(bytes.size);c.outputStream.use { it.write(bytes) }
            } else cancellation?.attach(c)
            val status=c.responseCode
            val input=if(status in 200..299)c.inputStream else c.errorStream
            val bytes=input?.use { stream ->
                val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                while(true){val n=stream.read(buffer);if(n<0)break;if(output.size()+n>4*1024*1024)throw IOException("合集响应过大");output.write(buffer,0,n)}
                output.toString("UTF-8")
            }.orEmpty()
            if(status !in 200..299) throw CollectionApiError(runCatching{JSONObject(bytes).optString("error")}.getOrDefault("network_error"),status)
            if(c.getHeaderField("X-Cairn-Collections")!="1")throw CollectionApiError("collections_unsupported",409)
            return JSONObject(bytes)
        } finally { cancellation?.release(c);c.disconnect() }
    }
}

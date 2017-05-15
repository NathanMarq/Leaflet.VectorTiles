/**
 * A canvas renderer that can draw fonts.
 * Useful for icon fonts.
 *
 * @class FontCanvas
 * @extends Canvas
 *
 * @example
 * var map = L.map('map', {
 *   renderer: new L.FontCanvas()
 * });
 */

L.FontCanvas = L.Canvas.extend({
  _updateCircle: function (layer) {
    if (!this._drawing || layer._empty()) { return; }

    var p = layer._point,
        ctx = this._ctx,
        r = layer._radius,
        s = (layer._radiusY || r) / r;

    this._drawnLayers[layer._leaflet_id] = layer;

    if (layer.options.content && layer.options.font) {
      ctx.font = layer.options.font;
      ctx.fillStyle = layer.options.color;
      ctx.fillText(layer.options.content, p.x, p.y);
    } else {
      if (s !== 1) {
        ctx.save();
        ctx.scale(1, s);
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y / s, r, 0, Math.PI * 2, false);

      if (s !== 1) {
        ctx.restore();
      }

      this._fillStroke(ctx, layer);
    }
  }
});


/**
 * Manages interactive tiles of data
 *
 * @class VectorTiles
 * @extends GridLayer
 *
 * @example
 * var vtLayer = new L.VectorTiles('http://mytiles.com/{z}/{x}/{y}.pbf', {
 *   map: map,
 *   debug: true
 * }).addTo(map);
 */

L.VectorTiles = L.GridLayer.extend({

  style: {},

  /**
   * Constructor
   *
   * @param {string} url The url for fectching vector tiles
   * @param {Object} options
   * @param {Function} [options.getFeatureId]
   * @param {boolean} [options.debug]
   * @param {Object} [options.style]
   * @private
   */
  initialize(url, options) {
    L.Util.setOptions(options);
    L.GridLayer.prototype.initialize.call(this, options);

    this._url = url;

    // TODO: figure out how to do without this
    this._map = options.map;

    // the FeatureGroup that holds per tile FeatureGroups
    this._featureGroup = L.featureGroup()
      .addTo(this._map);

    // show tile boundaries
    this._debug = options.debug;

    // pointers to individual layers
    // this._vectorTiles = {
    //   <tileKey>: {
    //     loaded: <Boolean>,
    //     features: {
    //       <featureId>: {
    //         geojson: <GeoJSON feature>,
    //         layer: <Leaflet layer>,
    //         indexEntry: <RBush index item>,
    //       }
    //     },
    //     featureGroup: <L.FeatureGroup>,
    //     index: <RBush>
    //     loaded: <boolean>,
    //     valid: <boolean>
    //   }
    // }
    this._vectorTiles = {};

    // property based style modifications
    // for highlighting and junk
    // this._propertyStyles = {
    //   propertyName: {
    //     value1: { L.Path style options }
    //   }
    // }
    this._propertyStyles = {};

    // property based toggling
    this._propertyOnMap = {};

    // track individual feature style modifications
    this._featureStyles = {};

    // mark individual features as on or off the map
    this._featureOnMap = {};

    // mark a tile as loaded
    // this is needed because if a tile is unloaded before its finished loading
    // we need to wait for it to finish loading before we can clean up
    this.on('vt_tileload', function onVtTileUnload(e) {
      var tileKey = this._tileCoordsToKey(e.coords);
      this._vectorTiles[tileKey].loaded = true;
      if (!this._vectorTiles[tileKey].valid) {
        this.destroyTile(e.coords);
      }
    });

    // listen for tileunload event and clean up old features
    this.on('tileunload', function onTileUnload(e) {
      var tileKey = this._tileCoordsToKey(e.coords);

      // if the tile hasn't loaded yet wait until it loads to destroy it
      if (!(tileKey in this._vectorTiles) || !this._vectorTiles[tileKey].loaded) {
        // invalidate the tile so that it is deleted when its done loading
        this._vectorTiles[tileKey].valid = 'false';
      } else {
        this.destroyTile(e.coords);
      }
    });

    // are you currently zooming
    this._zooming = false;

    this._map.on('zoomstart', function onZoomStart() {
      this._zooming = true;
    }.bind(this));

    this._map.on('zoomend', function onZoomEnd() {
      this._zooming = false;
    }.bind(this));

    // tiles to be loaded
    this._tileQueue = {};
  },

  /**
   * This method laoads all features in a tile into an r-tree
   * This method is called after a tile is finished loading so that inserting
   * a feature into the tree is done once in bulk
   * Features in the tree have an id property generated by the `getFeatureId`
   * function to enable removing features from the tree
   *
   * @param {Object} coords
   * @private
   */
  _bulkInsertTileIntoIndex(coords) {
    var tileKey = this._tileCoordsToKey(coords);

    this._vectorTiles[tileKey].index = rbush();

    var features = this._vectorTiles[tileKey].features;
    var bboxes = [];
    for (var id in features) {
      var geojson = features[id].geojson;
      var geom = geojson.geometry;
      var c = geojson.geometry.coordinates;

      var minX, minY, maxX, maxY;

      if (geom.type === 'Point') {
        minX = maxX = c[0];
        minY = maxY = c[1];
      } else {
        var bbox = turf.bbox(geom);
        minX = bbox[0];
        minY = bbox[1];
        maxX = bbox[2];
        maxY = bbox[3];
      }

      var item = {
        minX: minX,
        minY: minY,
        maxX: maxX,
        maxY: maxY,
        id: this.options.getFeatureId(geojson),
      };

      features[id].indexEntry = item;

      bboxes.push(item);
    }

    // bulk load all the features for this tile
    this._vectorTiles[tileKey].index.load(bboxes);
  },

  /**
   * Returns an array of feature ids near a given point
   *
   * @param {L.LatLng} min
   * @param {L.LatLng} max
   * @returns {Array<string>}
   */
  search(min, max) {
    if (!this._map) {
      throw new Error('Vector tile layer not added to the map.')
    }

    let results = new Set();

    for (let tileKey in this._vectorTiles) {
      if (!this._vectorTiles[tileKey] || !this._vectorTiles[tileKey].index)
        continue; // index may not be built yet

      let tree = this._vectorTiles[tileKey].index
      let minX = min.lng;
      let minY = min.lat;
      let maxX = max.lng;
      let maxY = max.lat;

      for (let result of tree.search({ minX, minY, maxX, maxY })) {
        results.add(result.id);
      }
    }

    return Array.from(results);
  },

  /**
   * This method:
   *   - fetches the data for the tile
   *   - adds all of its features to the map
   *   - adds its features to the internal data structure
   *   - inserts its features into the a spatial tree
   *
   * @param {Object} coords
   * @param {Function} done
   * @fires vt_tileload
   * @returns DOM element
   * @private
   */
  createTile: function(coords, done) {
    var tile = L.DomUtil.create('div', 'leaflet-tile');
    if (this.options.debug) {
      // show tile boundaries
      tile.style.outline = '1px solid red';
    }
    this._createTile(coords);
    var tileKey = this._tileCoordsToKey(coords);
    this._tileQueue[tileKey] = true;
    done(null, tile);
    return tile;
  },

  _createTile: function(coords) {
    var tileKey = this._tileCoordsToKey(coords);

    var featureGroup = L.featureGroup();

    this._vectorTiles[tileKey] = {
      features: {},
      featureGroup: featureGroup,
      valid: true
    };

    // fetch vector tile data for this tile
    var url = L.Util.template(this._url, coords);
    fetch(url)
      .then(res => res.json())
      .then(layers => {
        for (var i = 0; i < layers.length; i++) {
          // break out if we're already past this zoom level
          // before we're done loading the tile
          if (coords.z !== this._map.getZoom()) {
            break;
          }
          for (var j = 0; j < layers[i].features.features.length; j++) {
            // break out if we're already past this zoom level
            // before we're done loading the tile
            if (coords.z !== this._map.getZoom()) {
              break;
            }

            var geojson = layers[i].features.features[j];
            var id = this.options.getFeatureId(geojson);
            var layer = this._geojsonToLayer(geojson, id);
            if (!layer) {
              // unsupported geometry type
              continue;
            }

            this._vectorTiles[tileKey].features[id] = {
              geojson: geojson,
              layer: layer
            };

            var style = {};
            var onMap = true;

            // property based styles
            for (var prop in geojson.properties) {
              // apply style from options
              if (prop in this.options.style
                  && geojson.properties[prop] in this.options.style[prop]) {
                Object.assign(style, this.options.style[prop][geojson.properties[prop]]);
              }

              // apply style modifications
              if (prop in this._propertyStyles
                  && geojson.properties[prop] in this._propertyStyles[prop]) {
                Object.assign(style, this._propertyStyles[prop][geojson.properties[prop]]);
              }

              // put on map based on property
              if (prop in this._propertyOnMap
                  && geojson.properties[prop] in this._propertyOnMap[prop]) {
                onMap = this._propertyOnMap[prop][geojson.properties[prop]];
              }
            }

            // feature based styles
            if (id in this._featureStyles) {
              Object.assign(style, this._featureStyles[id]);
            }

            layer.setStyle(style);

            // feature based on map
            if (id in this._featureOnMap) {
              onMap = this._featureOnMap[id];
            }

            if (onMap) {
              featureGroup.addLayer(layer);
            }
          }
        }

        // load new features into spatial index
        this._bulkInsertTileIntoIndex(coords);

        // add the featureGroup of this tile to the map
        featureGroup.addTo(this._featureGroup);

        // the tile has ~actually~ loaded
        // the `tileload` event doesn't fire when `tileunload` fires first
        // but in our case we still need to be finished loading to clean up
        this.fire('vt_tileload', { coords: coords });
      });
  },

  /**
   * Remove the features of a tile from the map and delete that tile's
   * data structure
   *
   * @param {Object} coords
   * @fires vt_tileunload
   * @private
   */
  destroyTile(coords) {
    var tileKey = this._tileCoordsToKey(coords);

    // remove this tile's FeatureGroup from the map
    this._featureGroup.removeLayer(this._vectorTiles[tileKey].featureGroup);

    // delete the tile's data
    delete this._vectorTiles[tileKey];

    this.fire('vt_tileunload', { coords: coords });
  },

  /**
   * Removes features from the map by property.
   * Wrapper function of `_toggleByProperty`.
   * Equivalent to `this._toggleByProperty(property, value, false)`.
   *
   * @param {string} property
   * @param {string} value
   */
  hideByProperty(property, value) {
    this._toggleByProperty(property, value, false);
    return this;
  },

  /**
   * Add features to the map by property.
   * Wrapper function of `_toggleByProperty`.
   * Equivalent to `this._toggleByProperty(property, value, true)`.
   *
   * @param {string} property
   * @param {string} value
   */
  showByProperty(property, value) {
    this._toggleByProperty(property, value, true);
    return this;
  },

  /**
   * Iterates over all features and add them to or removes them from
   * the map based on a property value
   *
   * @param {string} property
   * @param {string} value
   * @param {boolean} on
   * @private
   */
  _toggleByProperty(property, value, on) {
    if (!(property in this._propertyOnMap)) {
      this._propertyOnMap[property] = {};
    }

    // did the state change?
    var toggled = this._propertyOnMap[property][value] !== on;

    this._propertyOnMap[property][value] = on;

    // iterate over all features and toggle as needed
    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      var featureGroup = this._vectorTiles[tileKey].featureGroup;
      for (var id in features) {
        var feature = features[id];
        if (property in feature.geojson.properties
            && feature.geojson.properties[property] === value) {
          if (toggled) {
            if (on) {
              // add to spatial index
              this._vectorTiles[tileKey].index.insert(feature.indexEntry);
              // add to map
              featureGroup.addLayer(feature.layer);
            } else {
              // remove from spatial index
              this._vectorTiles[tileKey].index.remove(feature.indexEntry);
              // remove from map
              featureGroup.removeLayer(feature.layer);
            }
          }
        }
      }
    }
  },

  /**
   * Change the style of features based on property values
   *
   * @param {string} property
   * @param {string} value
   * @param {Object} style
   * @returns {L.VectorTiles} this
   */
  restyleByProperty(property, value, style) {
    if (!(property in this._propertyStyles)) {
      this._propertyStyles[property] = {};
    }

    if (!(value in this._propertyStyles[property])) {
      this._propertyStyles[property][value] = {};
    }

    Object.assign(this._propertyStyles[property][value], style);

    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      for (var id in features) {
        var feature = features[id];
        if (property in feature.geojson.properties
            && feature.geojson.properties[property] === value) {
          feature.layer.setStyle(style);
        }
      }
    }

    return this;
  },

  /**
   * Change the style of a feature by its id
   *
   * @param {string} id
   * @param {Object} style
   * @returns {L.VectorTiles} this
   */
  setFeatureStyle(id, style) {
    this._featureStyles[id] = style;
    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      if (id in features) {
        var layer = features[id].layer;
        layer.setStyle(style);
      }
    }
    return this;
  },

  /**
   * TODO.
   * Revert a feature to its origin style.
   *
   * @param {string} id
   */
  resetFeatureStyle(id) {
    delete this._featureStyles[id];
    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      if (id in features) {
        var layer = features[id].layer;
        // layer.resetStyle();
      }
    }
  },

  /**
   * Returns the feature group that holds all features in the GridLayer
   * intended for use with Leaflet.Draw
   *
   * @returns {L.FeatureGroup}
   */
  getFeatureGroup() {
    return this._featureGroup;
  },

  /**
   * Returns a reference to the layer identified by the id
   *
   * @param {string} id
   * @returns {L.Path}
   */
  getLayer(id) {
    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      for (var featureId in features) {
        if (featureId === id) {
          return features[id].layer;
        }
      }
    }
    return null;
  },

  /**
   * Returns a reference to the GeoJSON feature identified by the id
   *
   * @param {string} id
   * @return {Object}
   */
  getGeoJSON(id) {
    for (var tileKey in this._vectorTiles) {
      var features = this._vectorTiles[tileKey].features;
      for (var featureId in features) {
        if (featureId === id) {
          return features[id].geojson;
        }
      }
    }
    return null;
  },

  /**
   * Deletes a feature by its ID
   * Note that this feature will still be loaded in subsequent tiles
   *
   * @param {string} id
   * @returns {L.VectorTiles} this
   */
  removeFeature(id) {
    for (var tileKey in this._vectorTiles) {
      var tile = this._vectorTiles[tileKey];
      var features = tile.features;
      for (var featureId in features) {
        if (featureId === id) {
          var feature = features[id];
          // remove layer from feature group
          tile.featureGroup.removeLayer(feature.layer);
          // remove from tile index
          tile.index.remove(feature.indexEntry);
          // remove from feature list
          delete features[id];
        }
      }
    }
    return this;
  },

  /**
   * Convert a GeoJSON feature into a Leaflet feature
   * Point -> L.Circle
   * LineString -> L.Polyline
   * Polygon/Multipolygon -> L.Polygon
   * Here we must make lon,lat (GeoJSON) into lat,lon (Leaflet)
   *
   * @param {Object} feature
   * @param {string} id
   * @returns {L.Path}
   * @private
   */
  _geojsonToLayer(feature, id) {
    var layer;
    switch (feature.geometry.type) {
      case 'Point':
        var coords = feature.geometry.coordinates;
        layer = L.circle([coords[1], coords[0]], {
          radius: 40
        });
        break;

      case 'LineString':
        var coords = feature.geometry.coordinates.map(c => [c[1], c[0]]);
        layer = L.polyline(coords, {});
        break;

      case 'Polygon':
      case 'MultiPolygon':
        var coords = feature.geometry.coordinates.map(ring => ring.map(c => [c[1], c[0]]));
        layer = L.polygon(coords, {});
        break;

      default:
        console.log('Unsupported feature type: ' + feature.geometry.type);
        return null;
    }

    layer.id = id;

    return layer;
  }

});

